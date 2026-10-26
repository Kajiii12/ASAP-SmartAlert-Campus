import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(
  process.env.PORT && process.env.PORT !== process.env.NGINX_PORT
    ? process.env.PORT
    : process.env.DEFAULT_APP_PORT || 3000
);

// Container health check endpoint for Cloud Run / deployment probes
app.get('/healthz', (_req, res) => {
  res.status(200).send('OK');
});

// Increase payload limit for camera photo base64
app.use(express.json({ limit: '15mb' }));

// Allow CORS so local Python ip_camera_bridge.py can push frames from 192.168.120.x LAN
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Latest frame buffer from Python IP Camera Bridge (Main Gate CAM 2 - http://192.168.120.220:8080/)
interface PythonCameraState {
  frameBase64: string | null;
  cameraUrl: string;
  updatedAt: number;
  framesReceived: number;
}

const pythonCamState: PythonCameraState = {
  frameBase64: null,
  cameraUrl: 'http://192.168.120.220:8080/',
  updatedAt: 0,
  framesReceived: 0,
};

// Spawn the background Python IP Camera Bridge (ip_camera_bridge.py)
let pythonBridgeProcess: ReturnType<typeof spawn> | null = null;
function ensurePythonBridgeRunning(targetUrl = 'http://192.168.120.220:8080/') {
  if (pythonBridgeProcess && !pythonBridgeProcess.killed) {
    return;
  }
  const scriptPath = path.join(__dirname, 'ip_camera_bridge.py');
  if (!fs.existsSync(scriptPath)) return;
  try {
    pythonBridgeProcess = spawn(
      'python3',
      [scriptPath, '--url', targetUrl, '--port', '5050', '--server', `http://127.0.0.1:${PORT}`],
      { stdio: 'ignore' }
    );
    pythonBridgeProcess.on('exit', () => {
      pythonBridgeProcess = null;
    });
    pythonBridgeProcess.on('error', (err) => {
      console.warn('Python camera bridge spawn error (non-fatal):', err.message);
      pythonBridgeProcess = null;
    });
  } catch (err) {
    console.warn('Could not spawn python3 bridge:', err);
  }
}

// Initialize GoogleGenAI SDK server-side dynamically
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Fast in-memory LRU cache for repeated image analyses
const analysisCache = new Map<string, any>();

function getRequiredContactsForType(
  type: 'lockdown' | 'medical' | 'fire' | 'severe_weather_evacuation' | 'garbage' | 'missing_lost_found'
) {
  switch (type) {
    case 'lockdown':
      return [
        {
          id: 'campus-soc-command',
          agency: 'Campus Security Command Post & Chief Security Officer',
          role: 'Immediate On-Campus Tactical Coordination & Guard Dispatch (Default First Call)',
          contactNumber: 'Campus Ext. 100 / Radio Ch. 1',
          category: 'campus',
        },
        {
          id: 'campus-guard-house',
          agency: 'Campus Guard House & All Gate Security Posts',
          role: 'Perimeter Gate Seal, Access Control & Patrol Mobilization',
          contactNumber: 'Guard House Ext. 101',
          category: 'guard_house',
        },
        {
          id: 'campus-admin-office',
          agency: "School Administration & Principal's Office",
          role: 'Executive Crisis Command & Internal Faculty/Student Lockdown Advisory',
          contactNumber: 'Admin Office Ext. 201',
          category: 'campus',
        },
      ];
    case 'medical':
      return [
        {
          id: 'auth-clinic',
          agency: 'Campus Clinic & Duty Physician / School Nurse',
          role: 'Immediate On-Campus First Aid, Triage & AED Deployment (Default First Call)',
          contactNumber: 'Campus Ext. 104',
          category: 'campus',
        },
        {
          id: 'campus-soc-med',
          agency: 'Campus Security Command Post & First Aid Escort',
          role: 'On-Scene Responder Escort & Stretcher Access Clearance',
          contactNumber: 'Campus Ext. 100',
          category: 'campus',
        },
        {
          id: 'campus-osa-med',
          agency: 'School Administration & Student Affairs Office (OSD)',
          role: 'Student/Staff Medical Record Lookup & Guardian Notification',
          contactNumber: 'Admin Office Ext. 204',
          category: 'campus',
        },
      ];
    case 'fire':
      return [
        {
          id: 'campus-fire-marshal',
          agency: 'Campus Fire Safety Marshal & Facilities Engineering',
          role: 'On-Campus Fire Extinguisher Team, Power/Gas Shutoff & Alarm Control (Default First Call)',
          contactNumber: 'Facilities Ext. 301',
          category: 'campus',
        },
        {
          id: 'campus-soc-fire',
          agency: 'Campus Security Command Post & Guard House',
          role: 'Sector Evacuation Guidance & Emergency Fire Lane Clearance',
          contactNumber: 'Campus Ext. 100 / Ext. 101',
          category: 'guard_house',
        },
        {
          id: 'campus-admin-fire',
          agency: 'School Administration & Emergency Coordinator',
          role: 'Assembly Point Roll Call & Campus Evacuation Oversight',
          contactNumber: 'Admin Office Ext. 201',
          category: 'campus',
        },
      ];
    case 'severe_weather_evacuation':
      return [
        {
          id: 'campus-drrm-office',
          agency: 'Campus Disaster & Evacuation Committee (School DRRM)',
          role: 'Internal Campus Evacuation Routing & Shelter Readiness (Default First Call)',
          contactNumber: 'Campus Ext. 102',
          category: 'campus',
        },
        {
          id: 'campus-soc-weather',
          agency: 'Campus Security Command Post & Guard House',
          role: 'Floor Wardens Mobilization & Flooded/Hazard Sector Cordon',
          contactNumber: 'Campus Ext. 100 / Ext. 101',
          category: 'guard_house',
        },
        {
          id: 'campus-facilities-weather',
          agency: 'Campus Facilities & Maintenance Engineering Office',
          role: 'Utility Shutoff, Structural Check & Drainage Control',
          contactNumber: 'Facilities Ext. 305',
          category: 'campus',
        },
      ];
    case 'garbage':
      return [
        {
          id: 'auth-campus-sanitation',
          agency: 'Campus Janitorial & Sanitation Services Office',
          role: 'Immediate On-Campus Waste Cleanup, Disinfection & Bin Clearing (Default First Call)',
          contactNumber: 'Facilities Ext. 305',
          category: 'sanitation',
        },
        {
          id: 'campus-facilities-env',
          agency: 'Campus Facilities & Environmental Management Office',
          role: 'Campus Waste Segregation & Internal Hauling Schedule',
          contactNumber: 'Facilities Ext. 302',
          category: 'campus',
        },
        {
          id: 'campus-admin-gso',
          agency: 'School General Services Office (GSO)',
          role: 'Sanitation Supply & Grounds Maintenance Supervision',
          contactNumber: 'Admin Office Ext. 208',
          category: 'campus',
        },
      ];
    case 'missing_lost_found':
      return [
        {
          id: 'auth-guard-house',
          agency: 'Campus Guard House & Gate Security Post',
          role: 'Alert Guard House to monitor campus gates, check exits & log missing/found item or person',
          contactNumber: 'Guard House Ext. 101 / Gate Radio Ch. 1',
          category: 'guard_house',
        },
        {
          id: 'auth-online-platform',
          agency: 'Campus Online Platform & Community Bulletin',
          role: 'Post Missing / Lost & Found bulletin with photo and description to the online platform',
          contactNumber: 'Online Platform / Campus Portal',
          category: 'online_platform',
        },
        {
          id: 'auth-lost-found-desk',
          agency: 'Student Affairs & Lost-and-Found Desk (OSD)',
          role: 'Safekeep found belongings, verify claimants & notify owners/parents',
          contactNumber: 'Admin Office Ext. 204',
          category: 'campus',
        },
      ];
  }
}

function normalizeDetectedType(
  rawType?: string,
  contextText = ''
): 'lockdown' | 'medical' | 'fire' | 'severe_weather_evacuation' | 'garbage' | 'missing_lost_found' {
  const t = (rawType || '').toLowerCase().trim();
  const ctx = `${t} ${contextText.toLowerCase()}`;

  if (t === 'missing_lost_found' || t === 'missing' || t === 'lost_and_found' || t === 'lost') {
    return 'missing_lost_found';
  }
  if (t === 'garbage') return 'garbage';
  if (t === 'severe_weather_evacuation' || t === 'severe_weather' || t === 'evacuation') {
    return 'severe_weather_evacuation';
  }
  if (t === 'fire' || t === 'medical' || t === 'lockdown') {
    return t;
  }

  if (
    ctx.includes('missing') ||
    ctx.includes('lost') ||
    ctx.includes('found') ||
    ctx.includes('wallet') ||
    ctx.includes('backpack') ||
    ctx.includes('unattended bag') ||
    ctx.includes('id card') ||
    ctx.includes('keys') ||
    ctx.includes('belonging') ||
    ctx.includes('valuables') ||
    ctx.includes('guard house')
  ) {
    return 'missing_lost_found';
  }
  if (
    ctx.includes('garbage') ||
    ctx.includes('trash') ||
    ctx.includes('waste') ||
    ctx.includes('litter') ||
    ctx.includes('rubbish') ||
    ctx.includes('bin') ||
    ctx.includes('dump') ||
    ctx.includes('sanitation') ||
    ctx.includes('plastic') ||
    ctx.includes('overflowing')
  ) {
    return 'garbage';
  }
  if (ctx.includes('fire') || ctx.includes('flame') || ctx.includes('smoke') || ctx.includes('burn')) {
    return 'fire';
  }
  if (
    ctx.includes('med') ||
    ctx.includes('injur') ||
    ctx.includes('faint') ||
    ctx.includes('unconscious') ||
    ctx.includes('bleed') ||
    ctx.includes('ambulance') ||
    ctx.includes('paramedic') ||
    ctx.includes('patient') ||
    ctx.includes('first aid') ||
    ctx.includes('cpr') ||
    ctx.includes('cardiac') ||
    ctx.includes('seizure') ||
    ctx.includes('fall')
  ) {
    return 'medical';
  }
  if (
    ctx.includes('weather') ||
    ctx.includes('flood') ||
    ctx.includes('storm') ||
    ctx.includes('tornado') ||
    ctx.includes('rain') ||
    ctx.includes('typhoon') ||
    ctx.includes('evac') ||
    ctx.includes('collapse') ||
    ctx.includes('gas') ||
    ctx.includes('hazmat') ||
    ctx.includes('chemical') ||
    ctx.includes('earthquake') ||
    ctx.includes('tree')
  ) {
    return 'severe_weather_evacuation';
  }
  if (
    ctx.includes('intruder') ||
    ctx.includes('weapon') ||
    ctx.includes('gun') ||
    ctx.includes('firearm') ||
    ctx.includes('knife') ||
    ctx.includes('lockdown') ||
    ctx.includes('breach') ||
    ctx.includes('armed')
  ) {
    return 'lockdown';
  }
  return 'medical';
}

// AI Emergency Analysis Endpoint
app.post('/api/ai/analyze-emergency', async (req, res) => {
  const startTime = Date.now();
  try {
    const { imageBase64, categoryHint, locationHint, fileNameHint, visualHint } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Image base64 data is required for visual analysis' });
    }

    const zone = locationHint || 'Main Gate';

    // Extract MIME type and clean base64 payload
    const mimeMatch = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

    // Check fast cache using a fingerprint of the image data + location
    const cacheKey = `v4_${cleanBase64.slice(0, 120)}_${cleanBase64.slice(-120)}_${cleanBase64.length}_${zone}`;
    if (analysisCache.has(cacheKey)) {
      const cached = analysisCache.get(cacheKey);
      return res.json({
        ...cached,
        latencyMs: Date.now() - startTime,
      });
    }

    const ai = getGenAI();

    // Real multimodal Gemini Vision analysis (primary: gemini-3.1-flash-lite with MINIMAL thinking)
    if (ai && !imageBase64.startsWith('data:image/svg+xml')) {
      const prompt = `Classify this campus incident photo at "${zone}" into ONE of these 6 categories based on visual evidence:
- "lockdown": Armed intruder, gun/firearm/knife/weapon, masked trespasser, perimeter breach, or physical violence. (ONLY use if weapon/intruder/violence is visible).
- "medical": Injured, unconscious, fainted, fallen, bleeding, or sick person; person on floor; ambulance, stretcher, paramedic, first-aid kit, or medical distress.
- "fire": Flames, fire, smoke, burning objects, sparks, charred equipment, fire alarm/extinguisher.
- "severe_weather_evacuation": Severe weather OR evacuation hazard (flooding, storm damage, fallen trees, heavy rain/typhoon, collapsed ceiling/wall, earthquake debris, gas/chemical spill, crowd evacuation).
- "garbage": Garbage, overflowing trash bins, litter, piles of waste/rubbish, dumped trash bags, or sanitation issue.
- "missing_lost_found": Missing person/student OR lost and found item (unattended backpack, bag, wallet, ID card, phone, laptop, keys, personal belongings left behind, or missing person poster/photo). For "missing_lost_found", immediateActions MUST include posting through the online platform and alerting the guard house.

Return ONLY valid JSON:
{
  "detectedType": "lockdown" | "medical" | "fire" | "severe_weather_evacuation" | "garbage" | "missing_lost_found",
  "title": "Short specific headline for ${zone}",
  "severity": "critical" | "high" | "medium" | "low",
  "suggestedZones": ["${zone}"],
  "summary": "2 concise sentences describing what is visible in the photo and the required response.",
  "immediateActions": ["Step 1", "Step 2", "Step 3"],
  "requiresLockdown": false,
  "confidenceScore": 0.96,
  "detectedHazards": ["Hazard 1", "Hazard 2"]
}`;

      const attempts: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [
        { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
        { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
        { model: 'gemini-3.8-flash', thinkingLevel: ThinkingLevel.LOW },
      ];

      for (let i = 0; i < attempts.length; i++) {
        const { model, thinkingLevel } = attempts[i];
        try {
          const response = await ai.models.generateContent({
            model,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: cleanBase64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel },
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          });

          const text = response.text;
          if (text) {
            const cleanedJson = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const parsed = JSON.parse(cleanedJson);
            const normalizedType = normalizeDetectedType(
              parsed.detectedType,
              `${parsed.title || ''} ${parsed.summary || ''} ${(parsed.detectedHazards || []).join(' ')}`
            );

            const defaultSeverity =
              normalizedType === 'lockdown' || normalizedType === 'fire'
                ? 'critical'
                : normalizedType === 'garbage' || normalizedType === 'missing_lost_found'
                ? 'medium'
                : 'high';

            const defaultActionsForType =
              normalizedType === 'missing_lost_found'
                ? [
                    'Post Missing / Lost & Found bulletin with photo through the Campus Online Platform',
                    'Alert the Guard House and gate security personnel to monitor exits and verify claimants',
                    `Log and secure item/report details at ${zone} & Student Affairs Lost-and-Found Desk`,
                  ]
                : [
                    `Dispatch campus response unit to ${zone}`,
                    'Notify relevant LGU, Barangay, and emergency authorities',
                    'Monitor sector camera feeds',
                  ];

            const finalSeverity =
              normalizedType === 'garbage' || normalizedType === 'missing_lost_found'
                ? parsed.severity === 'medium' || parsed.severity === 'low'
                  ? parsed.severity
                  : 'medium'
                : ['critical', 'high', 'medium', 'low'].includes(parsed.severity)
                ? parsed.severity
                : defaultSeverity;

            const isCriticalLevel = finalSeverity === 'critical';
            const allCampusZones = [
              'Main Gate',
              'Gymnasium',
              'Academic Building',
              'Admin Building',
              'Canteen',
              'Gate 2',
              'Gate 3',
            ];

            const resultPayload = {
              success: true,
              source: model,
              latencyMs: Date.now() - startTime,
              detectedType: normalizedType,
              title:
                parsed.title ||
                (normalizedType === 'missing_lost_found'
                  ? `Missing / Lost & Found — ${zone}`
                  : `${normalizedType.replace(/_/g, ' ').toUpperCase()} — ${zone}`),
              severity: finalSeverity,
              suggestedZones: isCriticalLevel
                ? allCampusZones
                : Array.isArray(parsed.suggestedZones) && parsed.suggestedZones.length > 0
                ? parsed.suggestedZones
                : [zone],
              summary:
                parsed.summary ||
                (normalizedType === 'missing_lost_found'
                  ? `AI Vision identified a Missing / Lost & Found report at ${zone}. Recommended action: post bulletin through the online platform and alert the Guard House immediately.`
                  : isCriticalLevel
                  ? `CRITICAL LEVEL EMERGENCY detected at ${zone}. Enforcing all campus areas on immediate lockdown, activating emergency sirens, and dispatching response units.`
                  : `AI Vision detected ${normalizedType.replace(/_/g, ' ')} indicators at ${zone}. Non-critical level — targeted response protocols initiated without campus lockdown.`),
              immediateActions:
                normalizedType === 'missing_lost_found'
                  ? defaultActionsForType
                  : isCriticalLevel
                  ? [
                      'CRITICAL LEVEL: Enforce all campus areas on full lockdown & seal magnetic doors',
                      'Activate campus-wide emergency sirens, strobes, and PA broadcast',
                      ...(Array.isArray(parsed.immediateActions) && parsed.immediateActions.length > 0
                        ? parsed.immediateActions.slice(0, 2)
                        : defaultActionsForType.slice(0, 2)),
                    ]
                  : Array.isArray(parsed.immediateActions) && parsed.immediateActions.length > 0
                  ? parsed.immediateActions.slice(0, 4)
                  : defaultActionsForType,
              requiresLockdown: isCriticalLevel,
              confidenceScore:
                typeof parsed.confidenceScore === 'number' && parsed.confidenceScore >= 0.5 && parsed.confidenceScore <= 1
                  ? parsed.confidenceScore
                  : 0.95,
              detectedHazards:
                Array.isArray(parsed.detectedHazards) && parsed.detectedHazards.length > 0
                  ? parsed.detectedHazards
                  : [normalizedType.toUpperCase()],
              requiredContacts: getRequiredContactsForType(normalizedType),
            };

            if (analysisCache.size > 50) {
              const firstKey = analysisCache.keys().next().value;
              if (firstKey) analysisCache.delete(firstKey);
            }
            analysisCache.set(cacheKey, resultPayload);
            return res.json(resultPayload);
          }
        } catch (geminiError: any) {
          console.warn(`Gemini vision attempt ${i + 1} (${model}) warning:`, geminiError?.status || geminiError?.message || geminiError);
          if (i < attempts.length - 1) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }
    }

    // Intelligent fallback for SVG sample previews or if all upstream models are temporarily unavailable
    const combinedHint = `${categoryHint || ''} ${fileNameHint || ''} ${visualHint || ''}`.toLowerCase();
    const detectedType = normalizeDetectedType(categoryHint || visualHint, combinedHint);
    const allCampusZones = [
      'Main Gate',
      'Gymnasium',
      'Academic Building',
      'Admin Building',
      'Canteen',
      'Gate 2',
      'Gate 3',
    ];

    let title = `Medical Emergency — ${zone}`;
    let severity = 'high';
    let suggestedZones = [zone];
    let summary = `AI Vision Analysis detected an individual in distress at ${zone} requiring immediate medical attention. First aid and paramedic response advised (High Severity — No Lockdown).`;
    let immediateActions = [
      `Dispatch Campus First Aid & AED unit to ${zone}`,
      'Notify LGU EMS Ambulance & Barangay BHERT responders',
      'Clear corridor pathways for incoming paramedic transport',
    ];
    let requiresLockdown = false;
    let detectedHazards = ['Medical Distress', 'Immediate First Aid Required'];

    if (detectedType === 'fire') {
      title = `Fire & Smoke Hazard — ${zone}`;
      severity = 'critical';
      suggestedZones = allCampusZones;
      summary = `AI Vision Analysis identified CRITICAL active flame and smoke signatures at ${zone}. Enforcing all campus areas on emergency protocol, activating sirens, and dispatching BFP fire suppression.`;
      immediateActions = [
        'CRITICAL LEVEL: Enforce all campus areas protocol, activate emergency sirens & strobes',
        'Call Bureau of Fire Protection (BFP) & Barangay Fire Brigade immediately',
        'Direct occupants to designated outdoor assembly points',
      ];
      requiresLockdown = true;
      detectedHazards = ['Active Flame / Smoke', 'Critical Thermal Hazard'];
    } else if (detectedType === 'severe_weather_evacuation') {
      title = `Severe Weather & Evacuation Alert — ${zone}`;
      severity = 'high';
      suggestedZones = [zone];
      summary = `AI Vision Analysis detected severe weather or structural evacuation hazards near ${zone}. Coordinated evacuation with LGU DRRMO and Barangay responders is required (Non-Critical — No Lockdown).`;
      immediateActions = [
        `Initiate safe evacuation of ${zone} to designated shelter areas`,
        'Coordinate with LGU DRRMO & Barangay Disaster Council (BDRRMC)',
        'Cordon off flooded or structurally compromised walkways',
      ];
      requiresLockdown = false;
      detectedHazards = ['Weather / Evacuation Hazard', 'Sector Clearance Required'];
    } else if (detectedType === 'garbage') {
      title = `Garbage & Sanitation Hazard — ${zone}`;
      severity = 'medium';
      suggestedZones = [zone];
      summary = `AI Vision Analysis identified uncollected garbage and overflowing waste accumulation at ${zone}. Campus sanitation cleanup and Barangay/LGU waste hauling are recommended (No Lockdown).`;
      immediateActions = [
        `Dispatch Campus Janitorial & Sanitation team to ${zone}`,
        'Coordinate waste collection with Barangay BESWMC & LGU CENRO',
        'Sanitize area and replace overflowing waste receptacles',
      ];
      requiresLockdown = false;
      detectedHazards = ['Unsanitary Waste Accumulation', 'Environmental Hygiene Issue'];
    } else if (detectedType === 'missing_lost_found') {
      title = `Missing / Lost & Found — ${zone}`;
      severity = 'medium';
      suggestedZones = [zone];
      summary = `AI Vision Analysis identified a Missing / Lost & Found item or person report at ${zone}. Suggested action: post bulletin with photo through the online platform and alert the Guard House immediately.`;
      immediateActions = [
        'Post Missing / Lost & Found bulletin with photo through the Campus Online Platform',
        'Alert the Guard House and gate security personnel to monitor exits and assist claimants',
        `Log and secure item/report details at ${zone} & Lost-and-Found Desk`,
      ];
      requiresLockdown = false;
      detectedHazards = ['Missing / Unattended Belonging or Person', 'Guard House & Online Bulletin Dispatch'];
    } else if (detectedType === 'lockdown') {
      title = `Armed Intruder Alert — ${zone}`;
      severity = 'critical';
      suggestedZones = allCampusZones;
      summary = `AI Vision Analysis detected a CRITICAL armed security threat near ${zone}. Enforcing all campus areas on immediate lockdown, activating emergency sirens & strobes, and notifying PNP Police, LGU, and Barangay authorities.`;
      immediateActions = [
        'CRITICAL LEVEL: Enforce all campus areas on full lockdown & seal magnetic doors',
        'Activate campus-wide emergency sirens, strobes & PA broadcast',
        'Call PNP Police Dispatch, LGU Command & Barangay Tanod immediately',
      ];
      requiresLockdown = true;
      detectedHazards = ['Perimeter Breach', 'Critical Armed Security Threat'];
    }

    return res.json({
      success: true,
      source: 'embedded-vision-engine',
      latencyMs: Date.now() - startTime,
      detectedType,
      title,
      severity,
      suggestedZones,
      summary,
      immediateActions,
      requiresLockdown: severity === 'critical',
      confidenceScore: 0.95,
      detectedHazards,
      requiredContacts: getRequiredContactsForType(detectedType),
    });
  } catch (error: any) {
    console.error('AI emergency analysis error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error during analysis' });
  }
});

// ============================================================================
// PYTHON IP CAMERA BRIDGE ENDPOINTS (Main Gate CAM 2 - http://192.168.120.220:8080/)
// ============================================================================

// 1. Receive live frames pushed by ip_camera_bridge.py
app.post('/api/camera/push-frame', (req, res) => {
  const { frameBase64, cameraUrl } = req.body || {};
  if (!frameBase64 || typeof frameBase64 !== 'string') {
    return res.status(400).json({ error: 'frameBase64 is required' });
  }
  pythonCamState.frameBase64 = frameBase64;
  if (cameraUrl) pythonCamState.cameraUrl = cameraUrl;
  pythonCamState.updatedAt = Date.now();
  pythonCamState.framesReceived += 1;
  return res.json({
    ok: true,
    framesReceived: pythonCamState.framesReceived,
    updatedAt: pythonCamState.updatedAt,
  });
});

// 2. Get latest frame from Python bridge (or run one-shot Python grabber if needed)
app.get('/api/camera/latest-frame', (req, res) => {
  const targetUrl = (req.query.url as string) || pythonCamState.cameraUrl || 'http://192.168.120.220:8080/';
  ensurePythonBridgeRunning(targetUrl);

  const isRecent = pythonCamState.frameBase64 && Date.now() - pythonCamState.updatedAt < 8000;
  if (isRecent) {
    return res.json({
      ok: true,
      hasFrame: true,
      frameBase64: pythonCamState.frameBase64,
      cameraUrl: pythonCamState.cameraUrl,
      updatedAt: pythonCamState.updatedAt,
      framesReceived: pythonCamState.framesReceived,
      engine: 'python3 ip_camera_bridge.py',
    });
  }

  // Attempt one-shot Python frame fetch via ip_camera_bridge.py --one-shot
  const scriptPath = path.join(__dirname, 'ip_camera_bridge.py');
  execFile(
    'python3',
    [scriptPath, '--one-shot', '--url', targetUrl],
    { encoding: 'buffer', timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    (err, stdout) => {
      if (!err && stdout && stdout.length > 100) {
        const b64 = `data:image/jpeg;base64,${stdout.toString('base64')}`;
        pythonCamState.frameBase64 = b64;
        pythonCamState.cameraUrl = targetUrl;
        pythonCamState.updatedAt = Date.now();
        pythonCamState.framesReceived += 1;
        return res.json({
          ok: true,
          hasFrame: true,
          frameBase64: b64,
          cameraUrl: targetUrl,
          updatedAt: pythonCamState.updatedAt,
          framesReceived: pythonCamState.framesReceived,
          engine: 'python3 ip_camera_bridge.py --one-shot',
        });
      }

      return res.json({
        ok: true,
        hasFrame: Boolean(pythonCamState.frameBase64),
        frameBase64: pythonCamState.frameBase64,
        cameraUrl: targetUrl,
        updatedAt: pythonCamState.updatedAt,
        framesReceived: pythonCamState.framesReceived,
        engine: 'python3 ip_camera_bridge.py',
      });
    }
  );
});

// 3. Proxy MJPEG stream from the background Python bridge on port 5050
app.get('/api/camera/python-stream', (req, res) => {
  const targetUrl = (req.query.url as string) || 'http://192.168.120.220:8080/';
  ensurePythonBridgeRunning(targetUrl);

  const proxyReq = http.get('http://127.0.0.1:5050/video', proxyRes => {
    res.writeHead(proxyRes.statusCode || 200, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.status(503).end();
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});

// 4. Download pre-configured ip_camera_bridge.py script
app.get('/api/camera/python-script', (req, res) => {
  const scriptPath = path.join(__dirname, 'ip_camera_bridge.py');
  const hostOrigin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
  try {
    let content = fs.readFileSync(scriptPath, 'utf-8');
    content = content.replace(
      'default="http://localhost:3000"',
      `default="${hostOrigin}"`
    );
    res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ip_camera_bridge.py"');
    res.send(content);
  } catch {
    res.status(404).send('# ip_camera_bridge.py not found');
  }
});

// ============================================================================
// MAIN SERVER REAL-TIME SYNCHRONIZATION HUB (/api/sync/state)
// Guarantees that mobile phones (on mobile data / Wi-Fi) and the Main Server
// stay 100% synchronized alongside Cloud Firestore.
// ============================================================================

interface ServerSyncState {
  version: number;
  updatedAt: number;
  incidents: Record<string, any>;
  deviceOverrides: Record<string, { categoryId: string; itemId: string; status: string; updatedAt: number }>;
  zoneStates: Record<string, { zoneId: string; doorsLocked: boolean; status?: string; updatedAt: number }>;
  activityLogs: Record<string, any>;
  paBroadcast: any | null;
}

const serverSyncState: ServerSyncState = {
  version: 1,
  updatedAt: Date.now(),
  incidents: {},
  deviceOverrides: {},
  zoneStates: {},
  activityLogs: {},
  paBroadcast: null,
};

// Synthesize PA Broadcast text to MP3 audio buffer so Android WebAPK / Chrome
// plays spoken announcements through Web Audio API (AudioContext) inside async callbacks
// without being blocked by Android speechSynthesis user-gesture policies.
async function synthesizeSpeechMp3Buffer(rawText: string): Promise<Buffer | null> {
  const clean = (rawText || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;

  // Split into safe <=180 char chunks on sentence/clause boundaries
  const words = clean.split(' ');
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > 175) {
      if (current.trim()) chunks.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const buffers: Buffer[] = [];
  for (const chunk of chunks.slice(0, 6)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        Referer: 'https://translate.google.com/',
      },
    });
    if (!res.ok) continue;
    const arr = await res.arrayBuffer();
    if (arr.byteLength > 0) {
      buffers.push(Buffer.from(arr));
    }
  }

  if (buffers.length === 0) return null;
  return Buffer.concat(buffers);
}

app.get('/api/tts', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim();
    const format = String(req.query.format || '').toLowerCase();
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Missing text parameter' });
    }

    const mp3Buffer = await synthesizeSpeechMp3Buffer(text);
    if (!mp3Buffer) {
      return res.status(502).json({ ok: false, error: 'TTS upstream unavailable' });
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (format === 'json') {
      return res.json({
        ok: true,
        audioBase64: mp3Buffer.toString('base64'),
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(mp3Buffer.length));
    return res.send(mp3Buffer);
  } catch (err) {
    console.warn('TTS synthesis error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to synthesize speech' });
  }
});

app.get('/api/sync/state', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.json({
    ok: true,
    serverTime: Date.now(),
    version: serverSyncState.version,
    updatedAt: serverSyncState.updatedAt,
    incidents: Object.values(serverSyncState.incidents),
    deviceOverrides: Object.values(serverSyncState.deviceOverrides),
    zoneStates: Object.values(serverSyncState.zoneStates),
    activityLogs: Object.values(serverSyncState.activityLogs),
    paBroadcast: serverSyncState.paBroadcast,
  });
});

app.post('/api/sync/state', (req, res) => {
  const body = req.body || {};
  const now = Date.now();
  let changed = false;

  if (body.reset === true) {
    serverSyncState.incidents = {};
    serverSyncState.deviceOverrides = {};
    serverSyncState.zoneStates = {};
    serverSyncState.activityLogs = {};
    serverSyncState.paBroadcast = null;
    changed = true;
  }

  if (body.paBroadcast && body.paBroadcast.id) {
    serverSyncState.paBroadcast = {
      ...body.paBroadcast,
      serverTimestampMs: now,
    };
    changed = true;
  }

  if (Array.isArray(body.seedIncidents)) {
    for (const inc of body.seedIncidents) {
      if (inc && inc.id && !serverSyncState.incidents[inc.id]) {
        serverSyncState.incidents[inc.id] = inc;
        changed = true;
      }
    }
  }

  if (body.incident && body.incident.id) {
    serverSyncState.incidents[body.incident.id] = body.incident;
    changed = true;
  }

  if (body.deviceOverride && body.deviceOverride.itemId) {
    serverSyncState.deviceOverrides[body.deviceOverride.itemId] = {
      ...body.deviceOverride,
      updatedAt: body.deviceOverride.updatedAt || now,
    };
    changed = true;
  }

  if (Array.isArray(body.deviceOverrides)) {
    for (const ov of body.deviceOverrides) {
      if (ov && ov.itemId) {
        serverSyncState.deviceOverrides[ov.itemId] = {
          ...ov,
          updatedAt: ov.updatedAt || now,
        };
        changed = true;
      }
    }
  }

  if (body.zoneState && body.zoneState.zoneId) {
    serverSyncState.zoneStates[body.zoneState.zoneId] = {
      ...body.zoneState,
      updatedAt: body.zoneState.updatedAt || now,
    };
    changed = true;
  }

  if (Array.isArray(body.zoneStates)) {
    for (const zs of body.zoneStates) {
      if (zs && zs.zoneId) {
        serverSyncState.zoneStates[zs.zoneId] = {
          ...zs,
          updatedAt: zs.updatedAt || now,
        };
        changed = true;
      }
    }
  }

  if (body.activityLog && body.activityLog.id) {
    serverSyncState.activityLogs[body.activityLog.id] = body.activityLog;
    // Keep most recent 60 logs in server memory
    const allLogs = Object.values(serverSyncState.activityLogs).sort(
      (a: any, b: any) => (b.timestampMs || 0) - (a.timestampMs || 0)
    );
    if (allLogs.length > 60) {
      const nextLogs: Record<string, any> = {};
      for (const l of allLogs.slice(0, 60)) {
        nextLogs[l.id] = l;
      }
      serverSyncState.activityLogs = nextLogs;
    }
    changed = true;
  }

  if (changed) {
    serverSyncState.version += 1;
    serverSyncState.updatedAt = now;
  }

  return res.json({
    ok: true,
    version: serverSyncState.version,
    updatedAt: serverSyncState.updatedAt,
  });
});

// Setup Vite in development or static serving in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  // Launch background Python IP Camera connector for Main Gate CAM 2
  ensurePythonBridgeRunning('http://192.168.120.220:8080/');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ASAP Safe Campus Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

