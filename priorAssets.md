# File: handlers/devices.ts

```typescript
import { CameraAnalysisService } from '../services/camera-analysis.service';
import { HassioApiService } from '../services/hassio.service';
import {
    CameraDevice,
    CameraSnapshotResponse,
    DeviceListResponse,
    Env,
    ErrorResponse,
    HomeAssistantDeviceState,
    PromptType
} from '../types';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';

export class DeviceHandler {
    private apiService: HassioApiService;
    private analysisService: CameraAnalysisService;
    private readonly BATCH_SIZE = 3;

    constructor(private readonly env: Env) {
        // COMMENTED OUT original implementation that could cause circular reference
        // this.apiService = new HassioApiService({ proxyToHomeAssistant });

        // NEW implementation to break circular reference
        this.apiService = new HassioApiService({
            proxyToHomeAssistant: async (request: Request, env: Env) => {
                try {
                    const url = new URL(request.url);
                    const newUrl = new URL(url.pathname + url.search, env.HASSIO_URL);
                    const headers = new Headers(request.headers);
                    headers.set('Authorization', `Bearer ${env.HASSIO_TOKEN}`);
                    
                    const newRequest = new Request(newUrl.toString(), {
                        method: request.method,
                        headers,
                        body: request.body
                    });
                    
                    return await fetch(newRequest);
                } catch (error) {
                    console.error('Proxy error:', error);
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Failed to proxy request',
                        details: error instanceof Error ? error.message : String(error)
                    }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
        });
        this.analysisService = new CameraAnalysisService(env);
    }

    // ... [ALL REMAINING CODE STAYS EXACTLY THE SAME] ...
}```

# File: handlers/enhanced-states.ts

```typescript
import { Env } from '../types';
import { error, json } from '../utils/response';

interface WebSocketClient {
    socket: WebSocket;
    subscriptions: Set<string>;
    lastPing: number;
}

export class EnhancedStatesHandler {
    private webSocketClients: Map<string, WebSocketClient> = new Map();
    private readonly PING_INTERVAL = 30000; // 30 seconds
    private readonly MAX_CLIENTS = 100;

    constructor(private readonly env: Env) {
        this.startPingInterval();
    }

    async handleRequest(request: Request): Promise<Response> {
        try {
            const url = new URL(request.url);

            // Handle WebSocket upgrades
            if (url.pathname === '/api/websocket' && request.headers.get('Upgrade') === 'websocket') {
                return this.handleWebSocketUpgrade(request);
            }

            // Handle regular state requests
            if (url.pathname.startsWith('/api/states')) {
                const response = await this.handleStateRequest(request);
                
                // Check if response is ok and has valid JSON
                if (!response.ok) {
                    const text = await response.text();
                    return error(response.status, {
                        error: 'Failed to fetch states from Home Assistant',
                        status: response.status,
                        details: text
                    });
                }

                try {
                    const data = await response.json();
                    return json({
                        success: true,
                        states: data
                    });
                } catch (parseError) {
                    console.error('Error parsing states response:', parseError);
                    return error(502, {
                        error: 'Invalid response from Home Assistant',
                        details: parseError instanceof Error ? parseError.message : String(parseError)
                    });
                }
            }

            return error(404, 'Not Found');
        } catch (err) {
            console.error('EnhancedStatesHandler error:', err);
            return error(500, {
                error: 'Internal server error',
                details: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private handleWebSocketUpgrade(request: Request): Response {
        // Check client limit
        if (this.webSocketClients.size >= this.MAX_CLIENTS) {
            return error(503, 'Too Many Connections');
        }

        try {
            const pair = new WebSocketPair();
            const client: WebSocketClient = {
                socket: pair[1],
                subscriptions: new Set(),
                lastPing: Date.now()
            };

            // Set up the client socket
            client.socket.addEventListener('message', (event) => {
                this.handleWebSocketMessage(client, event);
            });

            client.socket.addEventListener('close', () => {
                this.webSocketClients.delete(pair[1].url);
            });

            client.socket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                this.webSocketClients.delete(pair[1].url);
            });

            this.webSocketClients.set(pair[1].url, client);

            // Accept the connection
            pair[1].accept();

            return new Response(null, {
                status: 101,
                webSocket: pair[0]
            });
        } catch (err) {
            console.error('WebSocket upgrade error:', err);
            return error(500, {
                error: 'Failed to establish WebSocket connection',
                details: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private async handleWebSocketMessage(client: WebSocketClient, event: MessageEvent) {
        try {
            const message = JSON.parse(event.data as string);

            switch (message.type) {
                case 'subscribe':
                    if (Array.isArray(message.entities)) {
                        message.entities.forEach((entity: string) => {
                            client.subscriptions.add(entity);
                        });
                        client.socket.send(JSON.stringify({
                            type: 'subscribed',
                            entities: Array.from(client.subscriptions)
                        }));
                    }
                    break;

                case 'unsubscribe':
                    if (Array.isArray(message.entities)) {
                        message.entities.forEach((entity: string) => {
                            client.subscriptions.delete(entity);
                        });
                        client.socket.send(JSON.stringify({
                            type: 'unsubscribed',
                            entities: message.entities
                        }));
                    }
                    break;

                case 'pong':
                    client.lastPing = Date.now();
                    break;

                default:
                    client.socket.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type'
                    }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            client.socket.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    }

    private startPingInterval() {
        setInterval(() => {
            const now = Date.now();
            this.webSocketClients.forEach((client, url) => {
                if (now - client.lastPing > this.PING_INTERVAL * 2) {
                    // Client hasn't responded to ping, close connection
                    client.socket.close(1000, 'Ping timeout');
                    this.webSocketClients.delete(url);
                } else {
                    // Send ping
                    client.socket.send(JSON.stringify({ type: 'ping' }));
                }
            });
        }, this.PING_INTERVAL);
    }

    private async handleStateRequest(request: Request): Promise<Response> {
        try {
            // Use HASSIO_URL consistently
            const response = await fetch(`${this.env.HASSIO_URL}/api/states`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.env.HASSIO_TOKEN}`,
                    'Accept': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });

            // Add response validation
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Home Assistant error response:', {
                    status: response.status,
                    body: errorText
                });
                
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Failed to fetch states from Home Assistant',
                    status: response.status,
                    details: errorText
                }), {
                    status: response.status,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    }
                });
            }

            // Validate the response is JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid response from Home Assistant',
                    details: 'Expected JSON response'
                }), {
                    status: 502,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    }
                });
            }

            const states = await response.json();
            return new Response(JSON.stringify({
                success: true,
                states: states
            }), {
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });

        } catch (err) {
            console.error('Error fetching states:', err);
            return new Response(JSON.stringify({
                success: false,
                error: 'Failed to fetch states',
                details: err instanceof Error ? err.message : String(err)
            }), {
                status: 502,
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });
        }
    }
}
```

# File: handlers/analysis.ts

```typescript
import { CameraAnalysisService } from '../services/camera-analysis.service';
import { HassioApiService } from '../services/hassio.service';
import { Env, PromptLibrary, PromptType } from '../types';
import { AnalysisContext, AnalysisResponse, CustomAnalysisRequest, DeviceAnalysisData } from '../types/analysis';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { getPrompt } from '../utils/prompts';

export class AnalysisHandler {
    private apiService: HassioApiService;
    private analysisService: CameraAnalysisService;
    private readonly BATCH_SIZE = 3;

    constructor(private readonly env: Env) {
        this.analysisService = new CameraAnalysisService(env);
        this.apiService = new HassioApiService({ proxyToHomeAssistant });
    }

    /**
     * Handle predefined analysis types using PROMPT_LIBRARY
     */
    async handlePredefinedAnalysis(
        promptType: string,
        category: string,
        requestId: string
    ): Promise<Response> {
        try {
            // Get prompt data
            const promptData = getPrompt(
                promptType as PromptType,
                category as keyof PromptLibrary[PromptType]
            );
            if (!promptData || Array.isArray(promptData)) {
                throw new Error(`Invalid prompt type or category: ${String(promptType)}/${String(category)}`);
            }

            // Gather data for all specified devices
            const devicesData = await this.gatherDevicesData(promptData.devices, requestId);

            // Create analysis context
            const context: AnalysisContext = {
                devices: devicesData,
                prompt: promptData.prompt,
                prompt_type: promptType as PromptType,
                category: String(category),
                request_id: requestId
            };

            // Run analysis
            return await this.runAnalysis(context);

        } catch (error) {
            return this.errorResponse('Failed to run predefined analysis', error, requestId);
        }
    }

    /**
     * Handle custom analysis requests
     */
    async handleCustomAnalysis(request: Request): Promise<Response> {
        const requestId = request.headers.get('cf-request-id') || crypto.randomUUID();

        try {
            // Parse request body
            const body = await request.json() as CustomAnalysisRequest;
            if (!body?.prompt_template?.devices || !body?.prompt_template?.prompt) {
                throw new Error('Invalid request body: missing devices or prompt');
            }

            // Gather data for specified devices
            const devicesData = await this.gatherDevicesData(body.prompt_template.devices, requestId);

            // Create analysis context
            const context: AnalysisContext = {
                devices: devicesData,
                prompt: body.prompt_template.prompt,
                request_id: requestId
            };

            // Run analysis
            return await this.runAnalysis(context);

        } catch (error) {
            return this.errorResponse('Failed to run custom analysis', error, requestId);
        }
    }

    /**
     * Gather data (snapshots and states) for specified devices
     */
    private async gatherDevicesData(devices: string[], requestId: string): Promise<DeviceAnalysisData[]> {
        const devicePromises = devices.map(async (deviceId) => {
            try {
                // Get device state
                const stateResponse = await this.apiService.getEntityState(this.env, deviceId);
                if (!stateResponse.ok) {
                    throw new Error(`Failed to fetch device state: ${stateResponse.status}`);
                }
                const state = await stateResponse.json();

                // For cameras, also get snapshot
                if (deviceId.startsWith('camera.')) {
                    const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${deviceId}`;
                    let snapshot_base64 = '';
                    try {
                        snapshot_base64 = await getBase64Snapshot(snapshotUrl, deviceId);
                    } catch (error) {
                        console.error(`[${requestId}] Failed to get snapshot for ${deviceId}:`, error);
                    }

                    return {
                        device_id: deviceId,
                        snapshot_base64,
                        snapshot_url: snapshotUrl,
                        state
                    };
                }

                // For non-camera devices, just return state
                return {
                    device_id: deviceId,
                    state
                };

            } catch (error) {
                console.error(`[${requestId}] Failed to gather data for ${deviceId}:`, error);
                return {
                    device_id: deviceId,
                    state: { error: 'Failed to gather device data' }
                };
            }
        });

        return await Promise.all(devicePromises);
    }

    /**
     * Run analysis on gathered device data
     */
    private async runAnalysis(context: AnalysisContext): Promise<Response> {
        try {
            const results = [];
            const timestamp = new Date().toISOString();

            // Process devices in batches
            for (let i = 0; i < context.devices.length; i += this.BATCH_SIZE) {
                const batch = context.devices.slice(i, i + this.BATCH_SIZE);
                console.log(`[${context.request_id}] Processing batch ${Math.floor(i/this.BATCH_SIZE) + 1} of ${Math.ceil(context.devices.length/this.BATCH_SIZE)}`);

                // Run AI analysis on batch
                const batchResults = await Promise.all(
                    batch.map(async (device) => {
                        try {
                            // For cameras, use vision AI
                            if (device.device_id.startsWith('camera.') && device.snapshot_base64) {
                                const analysis = await this.analysisService.analyzeSingleCamera(
                                    device.device_id,
                                    {
                                        success: true,
                                        snapshot_base64: device.snapshot_base64,
                                        snapshot_url: device.snapshot_url || ''
                                    },
                                    device.snapshot_url || '',
                                    context.prompt_type || 'general_status'
                                );

                                return {
                                    device_id: device.device_id,
                                    analysis: analysis.description,
                                    timestamp,
                                    snapshot_url: device.snapshot_url,
                                    state: device.state
                                };
                            }

                            // For non-camera devices, just include state
                            return {
                                device_id: device.device_id,
                                analysis: 'Non-camera device state recorded',
                                timestamp,
                                state: device.state
                            };

                        } catch (error) {
                            console.error(`[${context.request_id}] Analysis failed for ${device.device_id}:`, error);
                            return {
                                device_id: device.device_id,
                                analysis: 'Analysis failed',
                                timestamp,
                                error: error instanceof Error ? error.message : String(error)
                            };
                        }
                    })
                );

                results.push(...batchResults);

                // Optional delay between batches
                if (i + this.BATCH_SIZE < context.devices.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            const response: AnalysisResponse = {
                success: true,
                request_id: context.request_id,
                results
            };

            return new Response(JSON.stringify(response), {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': context.request_id
                }
            });

        } catch (error) {
            return this.errorResponse('Analysis failed', error, context.request_id);
        }
    }

    private errorResponse(message: string, error: unknown, requestId?: string): Response {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[${requestId || 'unknown'}] ${message}:`, error);

        const response: AnalysisResponse = {
            success: false,
            request_id: requestId || 'unknown',
            results: [],
            error: message,
            details: errorMessage
        };

        return new Response(JSON.stringify(response), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                ...(requestId && { 'X-Request-ID': requestId })
            }
        });
    }
}
```

# File: services/camera-analysis.service.ts

```typescript
/**
 * @fileoverview Camera Analysis Service using Cloudflare AI
 * Provides AI-powered visual analysis of camera feeds
 */

import {
    AiResponse,
    CameraAnalysisResult,
    CameraDevice,
    CameraSnapshotResponse,
    Env,
    HomeAssistantProxy,
    PromptType
} from '../types';
import { HassioApiService } from './hassio.service';
import { getCameraInfo, getCamerasByGroup, getCamerasByUseCase } from '../utils/camera';
import { CameraMetadata } from '../types';
import { getPrompt, getPromptCategoryForCamera } from '../utils/prompts';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { selectAIModel } from '../utils/model-selector';

export class CameraAnalysisService {
    private model: string;
    private memoryUsage: { [key: string]: number } = {};

    private apiService: HassioApiService;

    /**
     * Converts CameraMetadata to CameraDevice
     */
    private metadataToDevice(camera: CameraMetadata): CameraDevice {
        return {
            entity_id: camera.camera_id,
            state: camera.state,
            attributes: camera.attributes,
            friendly_name: camera.camera_id,
            motion_detection: false,
            stream_type: "unknown",
            width: 0,
            height: 0,
            fps: 0,
            bitrate: 0,
            channel_id: '',
            attribution: "Unknown",
            supported_features: 0,
            last_changed: new Date().toISOString(),
            last_updated: new Date().toISOString(),
            last_reported: new Date().toISOString(),
            snapshot_url: camera.snapshot_data.snapshot_url,
            stream_url: `${this.env.HASSIO_URL}/api/camera_proxy_stream/${camera.camera_id}`,
            snapshot_base64: camera.snapshot_data.snapshot_base64,
            snapshot_data: camera.snapshot_data,
            prompt_class: 'general_status'
        };
    }

    constructor(private readonly env: Env) {
        this.model = selectAIModel('image_analysis');
        this.apiService = new HassioApiService({ proxyToHomeAssistant: proxyToHomeAssistant });
    }

    /**
     * Analyzes a single camera feed using AI vision model with optimized memory usage
     */
    async analyzeSingleCamera(
        cameraId: string,
        snapshotData: CameraSnapshotResponse,
        stream_url: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult> {
        const startTime = performance.now();
        try {
            if (!snapshotData.success || !snapshotData.snapshot_base64) {
                throw new Error(`Failed to get snapshot for camera ${cameraId}`);
            }

            // Get prompt data first to fail fast if invalid
            const promptCategories = getPromptCategoryForCamera(cameraId, prompt_class);
            if (!promptCategories.length) {
                throw new Error(`No valid prompt category found for camera ${cameraId}`);
            }

            const { category } = promptCategories[0];
            const promptData = getPrompt(prompt_class, category);
            if (!promptData || Array.isArray(promptData)) {
                throw new Error(`No valid prompt found for camera ${cameraId} in class ${prompt_class}`);
            }

            // Get camera metadata
            const metadata = await getCameraInfo(this.env, this.apiService, cameraId);
            const cameraMetadata = Array.isArray(metadata)
                ? metadata.find(cam => cam.camera_id === cameraId)
                : metadata;

            if (!cameraMetadata) {
                throw new Error(`No metadata found for camera ${cameraId}`);
            }

            // Construct minimal system prompt
            const systemPrompt = `You are a security camera analyst focused on ${promptData.description}. Location: ${cameraMetadata.location} (${cameraMetadata.floor}). Group: ${cameraMetadata.group}. Key zones: ${cameraMetadata.key_zones.join(", ")}.`;

            // Run AI analysis
            const aiResponse = await this.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `data:image/jpeg;base64,${snapshotData.snapshot_base64}` },
                    { role: 'user', content: promptData.prompt }
                ]
            }) as AiResponse;

            return {
                camera_id: cameraId,
                description: aiResponse.response,
                snapshot_url: snapshotData.snapshot_url,
                stream_url,
                snapshot_base64: snapshotData.snapshot_base64,
                timestamp: new Date().toISOString()
            };
        } finally {
            const endTime = performance.now();
            this.memoryUsage[cameraId] = endTime - startTime;
        }
    }

    /**
     * Analyzes multiple cameras with batched processing and memory optimization
     */
    async analyzeCameras(
        cameras: CameraDevice[],
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        try {
            const results: CameraAnalysisResult[] = [];
            const batchSize = 3; // Process cameras in smaller batches

            for (let i = 0; i < cameras.length; i += batchSize) {
                const batch = cameras.slice(i, i + batchSize);
                console.log(`Processing batch ${i/batchSize + 1} of ${Math.ceil(cameras.length/batchSize)}`);

                const batchResults = await Promise.all(
                    batch.map(camera =>
                        this.analyzeSingleCamera(
                            camera.entity_id,
                            {
                                success: true,
                                snapshot_base64: camera.snapshot_base64,
                                snapshot_url: camera.snapshot_url
                            },
                            camera.stream_url,
                            prompt_class
                        ).catch(error => {
                            console.error(`Error analyzing camera ${camera.entity_id}:`, error);
                            return null;
                        })
                    )
                );

                results.push(...batchResults.filter((result): result is CameraAnalysisResult => result !== null));

                // Log memory usage after each batch
                console.log('Memory usage for batch:',
                    batch.map(camera => ({
                        camera: camera.entity_id,
                        time: this.memoryUsage[camera.entity_id]
                    }))
                );

                // Optional: Add delay between batches if needed
                if (i + batchSize < cameras.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            return results;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('Error analyzing cameras:', error);
            throw new Error(`Failed to analyze cameras: ${errorMessage}`);
        }
    }

    /**
     * Analyzes cameras by group
     */
    async analyzeCamerasByGroup(
        group: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        const cameras = await getCamerasByGroup(this.env, this.apiService, group);
        const cameraDevices = cameras.map((camera: CameraMetadata) => this.metadataToDevice(camera));
        return this.analyzeCameras(cameraDevices, prompt_class);
    }

    /**
     * Analyzes cameras by use case
     */
    async analyzeCamerasByUseCase(
        useCase: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        const cameras = await getCamerasByUseCase(this.env, this.apiService, useCase);
        const cameraDevices = cameras.map((camera: CameraMetadata) => this.metadataToDevice(camera));
        return this.analyzeCameras(cameraDevices, prompt_class);
    }
}
```

# File: services/documentation.service.ts

```typescript
interface Parameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface RequestBody {
  type: string;
  example: Record<string, any>;
}

interface ResponseFormat {
  example: Record<string, any> | string;
}

interface Endpoint {
  path: string;
  method: string;
  description: string;
  auth_required: boolean;
  parameters?: Parameter[];
  request_body?: RequestBody;
  response_format?: ResponseFormat;
  notes?: string;
}

interface Documentation {
  api_endpoints: Endpoint[];
  custom_endpoints: Endpoint[];
  system_endpoints: Endpoint[];
}

interface SecurityScheme {
  type: string;
  in?: string;
  name?: string;
  scheme?: string;
  description?: string;
}

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  components: {
    securitySchemes: {
      CloudflareApiKey: SecurityScheme;
      HassioToken: SecurityScheme;
    };
  };
  paths: Record<string, any>;
}

export class ApiDocumentation {
  getEndpointDocs(): Documentation {
    return {
      api_endpoints: [
        {
          path: "/api/",
          method: "GET",
          description: "API Discovery endpoint",
          auth_required: true,
          parameters: [],
          response_format: {
            example: {
              "message": "API running"
            }
          }
        },
        {
          path: "/api/config",
          method: "GET",
          description: "Get Home Assistant configuration",
          auth_required: true,
          parameters: [],
          response_format: {
            example: {
              "location_name": "Home",
              "latitude": 0,
              "longitude": 0,
              "elevation": 0,
              "unit_system": {
                "length": "km",
                "mass": "kg",
                "temperature": "°C",
                "volume": "L"
              },
              "time_zone": "UTC",
              "components": [],
              "config_dir": "/config",
              "whitelist_external_dirs": [],
              "allowlist_external_dirs": [],
              "allowlist_external_urls": [],
              "version": "2024.1.0"
            }
          }
        },
        {
          path: "/api/camera_proxy/{camera_id}",
          method: "GET",
          description: "Get camera snapshot",
          auth_required: true,
          parameters: [{
            name: "camera_id",
            type: "string",
            description: "Camera entity ID",
            required: true
          }],
          response_format: {
            example: "Binary image data"
          }
        },
        {
          path: "/api/camera_proxy_stream/{camera_id}",
          method: "GET",
          description: "Get camera stream",
          auth_required: true,
          parameters: [{
            name: "camera_id",
            type: "string",
            description: "Camera entity ID",
            required: true
          }],
          response_format: {
            example: "Video stream data"
          }
        }
      ],
      custom_endpoints: [
        {
          path: "/devices",
          method: "GET",
          description: "Get all devices (filtered)",
          auth_required: true,
          notes: "Excludes device_tracker entities",
          response_format: {
            example: {
              devices: [
                {
                  entity_id: "light.living_room",
                  state: "on",
                  attributes: {
                    friendly_name: "Living Room Light"
                  }
                }
              ],
              count: 1
            }
          }
        },
        {
          path: "/devices/cameras",
          method: "GET",
          description: "Get all camera devices with enhanced information",
          auth_required: true,
          response_format: {
            example: {
              devices: [{
                entity_id: "camera.front_door",
                state: "recording",
                attributes: {
                  friendly_name: "Front Door Camera"
                },
                snapshot_url: "https://hassio-api.hacolby.workers.dev/api/camera_proxy/camera.front_door",
                stream_url: "https://hassio-api.hacolby.workers.dev/api/camera_proxy_stream/camera.front_door",
                snapshot_base64: "base64_encoded_image_data..."
              }],
              count: 1
            }
          }
        },
        {
          path: "/chat",
          method: "POST",
          description: "AI-powered security analysis and automation",
          auth_required: true,
          request_body: {
            type: "json",
            example: {
              message: "Perform a security check",
              session_id: "security-123"
            }
          },
          response_format: {
            example: {
              role: "assistant",
              content: {
                car_parked: true,
                garage_door_open: false,
                vehicle_details: {
                  make: "Toyota",
                  model: "Camry",
                  color: "Silver",
                  license_plate: "ABC123"
                },
                person_at_door: false,
                package_present: true,
                package_details: {
                  type: "Amazon",
                  appearance: "Large brown box"
                },
                people_present: false,
                dogs_present: true,
                dog_details: {
                  breed: ["French Bulldog"],
                  activity: "Sleeping on couch"
                },
                robot_status: {
                  operating: true,
                  stuck: false
                },
                roof_water_present: false,
                suspicious_activity: false
              }
            }
          },
          notes: "Integrates with Home Assistant for automated security responses including camera analysis and notifications"
        }
      ],
      system_endpoints: [
        {
          path: "/cf-worker/health",
          method: "GET",
          description: "System health check",
          auth_required: false,
          response_format: {
            example: {
              "API Key Verification": {
                "passed": true
              },
              "HomeAssistant Connection": {
                "passed": true,
                "note": "Connected to Home"
              }
            }
          }
        }
      ]
    };
  }

  generateMarkdown(): string {
    const docs = this.getEndpointDocs();
    let markdown = '# Home Assistant API Worker Documentation\n\n';

    markdown += '## Authentication\n\n';
    markdown += 'Authentication is handled in two ways:\n\n';
    markdown += '1. Cloudflare-specific endpoints (/cf-worker/*, /devices/*, /chat) require an API key in the X-Api-Key header\n';
    markdown += '2. Home Assistant API endpoints (/api/*) require a Bearer token in the Authorization header\n\n';

    markdown += '## Security Features\n\n';
    markdown += 'The API includes AI-powered security features:\n\n';
    markdown += '- Automated garage door monitoring\n';
    markdown += '- Package and delivery detection\n';
    markdown += '- Camera feed analysis\n';
    markdown += '- Indoor monitoring with pet detection\n';
    markdown += '- Roof condition monitoring\n';
    markdown += '- Automated security responses\n\n';

    markdown += '## Camera Integration\n\n';
    markdown += 'Camera endpoints provide:\n\n';
    markdown += '- Direct snapshot access\n';
    markdown += '- Live video streaming\n';
    markdown += '- Base64 encoded snapshots\n';
    markdown += '- AI-powered scene analysis\n\n';

    markdown += '## API Endpoints\n\n';
    docs.api_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      markdown += `- Method: ${endpoint.method}\n`;
      markdown += `- Description: ${endpoint.description}\n`;
      markdown += `- Authentication Required: ${endpoint.auth_required}\n`;

      if (endpoint.notes) {
        markdown += `- Notes: ${endpoint.notes}\n`;
      }

      if (endpoint.parameters && endpoint.parameters.length > 0) {
        markdown += '\nParameters:\n';
        endpoint.parameters.forEach(param => {
          markdown += `- ${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}\n`;
        });
      }

      if (endpoint.request_body) {
        markdown += '\nRequest Body Example:\n```json\n';
        markdown += JSON.stringify(endpoint.request_body.example, null, 2);
        markdown += '\n```\n';
      }

      if (endpoint.response_format) {
        markdown += '\nResponse Format Example:\n```json\n';
        markdown += JSON.stringify(endpoint.response_format.example, null, 2);
        markdown += '\n```\n';
      }

      markdown += '\n';
    });

    markdown += '## Custom Endpoints\n\n';
    docs.custom_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      // ... similar to API endpoints
    });

    markdown += '## System Endpoints\n\n';
    docs.system_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      // ... similar to API endpoints
    });

    return markdown;
  }

  generateHtml(): string {
    const docs = this.getEndpointDocs();
    let html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Home Assistant API Worker Documentation</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
              line-height: 1.6;
              max-width: 1200px;
              margin: 0 auto;
              padding: 20px;
              color: #333;
            }
            h1, h2, h3 { color: #2c3e50; }
            .endpoint {
              background: #f8f9fa;
              border: 1px solid #dee2e6;
              border-radius: 4px;
              padding: 20px;
              margin: 20px 0;
            }
            .method {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-weight: bold;
            }
            .get { background: #e3f2fd; }
            .post { background: #e8f5e9; }
            .auth-type {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 0.9em;
              margin-left: 8px;
            }
            .auth-cloudflare {
              background: #f0ad4e;
              color: white;
            }
            .auth-hassio {
              background: #5bc0de;
              color: white;
            }
            pre {
              background: #f5f5f5;
              padding: 10px;
              border-radius: 4px;
              overflow-x: auto;
            }
            .notes {
              background: #fff3e0;
              padding: 10px;
              border-radius: 4px;
              margin: 10px 0;
            }
            .security-features {
              background: #e8eaf6;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
            }
            .camera-integration {
              background: #e0f2f1;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
            }
          </style>
        </head>
        <body>
          <h1>Home Assistant API Worker Documentation</h1>

          <section class="security-features">
            <h2>Security Features</h2>
            <ul>
              <li>AI-powered security analysis</li>
              <li>Automated garage door monitoring</li>
              <li>Package and delivery detection</li>
              <li>Camera feed analysis</li>
              <li>Indoor monitoring with pet detection</li>
              <li>Roof condition monitoring</li>
            </ul>
          </section>

          <section class="camera-integration">
            <h2>Camera Integration</h2>
            <ul>
              <li>Direct snapshot access</li>
              <li>Live video streaming</li>
              <li>Base64 encoded snapshots</li>
              <li>AI-powered scene analysis</li>
            </ul>
          </section>

          <h2>API Endpoints</h2>
          ${docs.api_endpoints.map(endpoint => `
            <div class="endpoint">
              <h3>${endpoint.path}</h3>
              <span class="method ${endpoint.method.toLowerCase()}">${endpoint.method}</span>
              <span class="auth-type ${endpoint.path.startsWith('/api/') ? 'auth-hassio' : 'auth-cloudflare'}">
                ${endpoint.path.startsWith('/api/') ? 'Bearer Token' : 'API Key'}
              </span>
              <p>${endpoint.description}</p>
              ${endpoint.notes ? `<div class="notes">${endpoint.notes}</div>` : ''}
              ${endpoint.parameters ? `
                <h4>Parameters</h4>
                <ul>
                  ${endpoint.parameters.map(param => `
                    <li>${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}</li>
                  `).join('')}
                </ul>
              ` : ''}
              ${endpoint.request_body ? `
                <h4>Request Body Example</h4>
                <pre><code>${JSON.stringify(endpoint.request_body.example, null, 2)}</code></pre>
              ` : ''}
              ${endpoint.response_format ? `
                <h4>Response Format Example</h4>
                <pre><code>${JSON.stringify(endpoint.response_format.example, null, 2)}</code></pre>
              ` : ''}
            </div>
          `).join('')}
        </body>
      </html>
    `;

    return html;
  }

  generateOpenApiSpec(): OpenApiSpec {
    const docs = this.getEndpointDocs();
    const spec: OpenApiSpec = {
      openapi: '3.0.0',
      info: {
        title: 'Home Assistant API Worker',
        version: '1.0.0',
        description: 'API for interacting with Home Assistant through Cloudflare Worker'
      },
      servers: [
        {
          url: 'https://hassio-api.hacolby.workers.dev',
          description: 'Production server'
        }
      ],
      components: {
        securitySchemes: {
          CloudflareApiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Api-Key',
            description: 'API key for Cloudflare-specific endpoints'
          },
          HassioToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'Bearer token for Home Assistant API endpoints'
          }
        }
      },
      paths: {}
    };

    // Convert endpoints to OpenAPI format
    [...docs.api_endpoints, ...docs.custom_endpoints, ...docs.system_endpoints].forEach(endpoint => {
      spec.paths[endpoint.path] = {
        [endpoint.method.toLowerCase()]: {
          summary: endpoint.description,
          security: endpoint.auth_required ? [
            endpoint.path.startsWith('/api/') ? { HassioToken: [] } : { CloudflareApiKey: [] }
          ] : [],
          parameters: endpoint.parameters?.map(param => ({
            name: param.name,
            in: 'path',
            required: param.required,
            schema: {
              type: param.type.toLowerCase()
            },
            description: param.description
          })) || [],
          requestBody: endpoint.request_body ? {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  example: endpoint.request_body.example
                }
              }
            }
          } : undefined,
          responses: {
            '200': {
              description: 'Successful response',
              content: endpoint.response_format ?
                typeof endpoint.response_format.example === 'string' ?
                  {
                    [endpoint.path.includes('camera_proxy_stream') ?
                      'video/*' :
                      'image/*']: {
                      schema: {
                        type: 'string',
                        format: 'binary'
                      }
                    }
                  } :
                  {
                    'application/json': {
                      schema: {
                        type: 'object',
                        example: endpoint.response_format.example
                      }
                    }
                  }
                : {}
            }
          }
        }
      };
    });

    return spec;
  }
}
```

# File: services/security.ts

```typescript
/**
 * @fileoverview Security Worker module for handling Home Assistant security features
 * This module provides AI-powered security analysis and automation for Home Assistant
 * including camera monitoring, garage automation, and security notifications.
 */

import { CameraAnalysisResult, Env, SecurityPatrolResult, SecurityResult } from '../types';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { PROMPT_LIBRARY } from '../utils/prompts';
import { CameraAnalysisService } from './camera-analysis.service';

/**
 * SecurityWorker class handles all security-related operations including
 * AI-powered analysis, camera monitoring, and automated security responses.
 */
export class SecurityWorker {
    private cameraAnalysisService: CameraAnalysisService;

    /**
     * Creates a new SecurityWorker instance
     * @param env - Environment variables and bindings
     */
    constructor(private readonly env: Env) {
        this.cameraAnalysisService = new CameraAnalysisService(env);
    }

    /**
     * Processes security findings and triggers appropriate automations
     * @param result - Security analysis results
     */
    private async handleSecurityFindings(result: SecurityResult): Promise<void> {
        // Garage & Vehicle Automation
        if (result.car_parked && result.garage_door_open) {
            await this.env.call('input_boolean.car_and_door_open', true);
        } else if (result.car_parked && !result.garage_door_open) {
            await this.env.call('input_boolean.car_and_door_closed', true);
        } else if (!result.car_parked && result.garage_door_open) {
            await this.env.call('input_boolean.no_car_and_door_open', true);
        } else if (!result.car_parked && !result.garage_door_open) {
            await this.env.call('input_boolean.no_car_and_door_closed', true);
        }

        // Package & Delivery Notifications
        if (result.person_at_door || result.package_present) {
            await this.env.call('notify.admin', {
                message: `Delivery Alert: ${
                    result.is_delivery_person ? 'Delivery person present' :
                    result.package_present ? 'Package detected' : 'Person at door'
                }`,
                data: {
                    details: result.person_description || result.package_details
                }
            });
        }

        // Indoor Monitoring
        if (result.robot_status?.stuck) {
            await this.env.call('notify.admin', {
                message: `Robot Stuck: Check ${result.robot_status.location}`
            });
        }

        // Roof Monitoring
        if (result.roof_water_present) {
            await this.env.call('notify.admin', {
                message: 'Roof Alert: Standing water detected',
                data: result.roof_water_details
            });
        }

        // General Security Alerts
        if (result.suspicious_activity) {
            await this.env.call('notify.admin', {
                message: `Security Alert: ${result.suspicious_activity_details}`
            });
        }
    }

    /**
     * Performs a security patrol by analyzing all security-related cameras
     * @returns Comprehensive security patrol results
     */
    private async performSecurityPatrol(): Promise<SecurityPatrolResult> {
        const patrolResult: SecurityPatrolResult = {
            timestamp: new Date().toISOString(),
            entry_points: { status: 'pending', details: '' },
            package_detection: { status: 'pending', details: '' },
            vehicle_monitoring: { status: 'pending', details: '' },
            indoor_monitoring: { status: 'pending', details: '' },
            roof_monitoring: { status: 'pending', details: '' },
            door_status: { status: 'pending', details: '' },
            garage_monitoring: { status: 'pending', details: '' },
            overall_security_status: 'secure',
            alerts: []
        };

        try {
            // Process each security category
            const categories = Object.keys(PROMPT_LIBRARY.security_analysis) as Array<keyof typeof PROMPT_LIBRARY.security_analysis>;
            for (const category of categories) {
                if (category === 'automated_security_sweep') continue;

                const promptData = PROMPT_LIBRARY.security_analysis[category];
                if (!Array.isArray(promptData) && promptData.devices) {
                    const results = await Promise.all(
                        promptData.devices.map(async (deviceId: string) => {
                            const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${deviceId}`;
                            return this.cameraAnalysisService.analyzeSingleCamera(
                                deviceId,
                                {
                                    success: true,
                                    snapshot_url: snapshotUrl,
                                    snapshot_base64: await getBase64Snapshot(snapshotUrl, deviceId)
                                },
                                `${this.env.HASSIO_URL}/api/camera_proxy_stream/${deviceId}`,
                                'security_analysis'
                            );
                        })
                    );

                    // Update patrol result for this category
                    const categoryResult = this.processAnalysisResults(results);
                    const categoryStatus = categoryResult.alerts.length > 0 ? 'warning' : 'secure';
                    const categoryKey = category as keyof Omit<SecurityPatrolResult, 'timestamp' | 'overall_security_status' | 'alerts'>;

                    if (categoryKey in patrolResult) {
                        patrolResult[categoryKey] = {
                            status: categoryStatus,
                            details: categoryResult.details,
                            alerts: categoryResult.alerts
                        };
                    }

                    // Add any alerts to the overall list
                    patrolResult.alerts.push(...categoryResult.alerts);
                }
            }

            // Determine overall security status
            patrolResult.overall_security_status = patrolResult.alerts.length > 0
                ? patrolResult.alerts.some(alert => alert.includes('CRITICAL')) ? 'alert' : 'warning'
                : 'secure';

            return patrolResult;
        } catch (error) {
            console.error('Security patrol error:', error);
            throw new Error('Failed to complete security patrol');
        }
    }

    /**
     * Processes analysis results from multiple cameras in a category
     * @param results - Array of camera analysis results
     * @returns Processed results with details and alerts
     */
    private processAnalysisResults(results: CameraAnalysisResult[]): {
        details: string;
        alerts: string[];
    } {
        const alerts: string[] = [];
        const details: string[] = [];

        for (const result of results) {
            const description = result.description.trim();
            details.push(`${result.camera_id}: ${description}`);

            // Extract alerts from the description
            if (description.toLowerCase().includes('alert') ||
                description.toLowerCase().includes('warning') ||
                description.toLowerCase().includes('suspicious')) {
                alerts.push(`${result.camera_id}: ${description}`);
            }
        }

        return {
            details: details.join('\n'),
            alerts
        };
    }

    /**
     * Main request handler for security-related endpoints
     * @param request - Incoming HTTP request
     * @returns HTTP response
     */
    async handleRequest(request: Request): Promise<Response> {
        try {
            const url = new URL(request.url);
            const path = url.pathname;

            // Handle camera proxy requests
            if (path.startsWith('/api/camera_proxy/') ||
                path.startsWith('/api/camera_proxy_stream/')) {
                return proxyToHomeAssistant(request, this.env);
            }

            // Handle security patrol request
            if (path === '/api/security/patrol') {
                const patrolResults = await this.performSecurityPatrol();
                return new Response(JSON.stringify(patrolResults), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle single camera analysis
            if (path.startsWith('/api/security/analyze/camera/')) {
                const cameraId = path.split('/').pop();
                if (!cameraId) {
                    throw new Error('Camera ID is required');
                }

                const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${cameraId}`;
                const result = await this.cameraAnalysisService.analyzeSingleCamera(
                    cameraId,
                    {
                        success: true,
                        snapshot_url: snapshotUrl,
                        snapshot_base64: await getBase64Snapshot(snapshotUrl, cameraId)
                    },
                    `${this.env.HASSIO_URL}/api/camera_proxy_stream/${cameraId}`,
                    'security_analysis'
                );

                return new Response(JSON.stringify(result), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle group analysis
            if (path.startsWith('/api/security/analyze/group/')) {
                const group = path.split('/').pop();
                if (!group) {
                    throw new Error('Group name is required');
                }

                const results = await this.cameraAnalysisService.analyzeCamerasByGroup(
                    group,
                    'security_analysis'
                );

                return new Response(JSON.stringify(results), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle zone analysis
            if (path.startsWith('/api/security/analyze/zone/')) {
                const zone = path.split('/').pop();
                if (!zone) {
                    throw new Error('Zone name is required');
                }

                const results = await this.cameraAnalysisService.analyzeCamerasByUseCase(
                    zone,
                    'security_analysis'
                );

                return new Response(JSON.stringify(results), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle security scan requests
            if (path === '/api/chat/security/scan') {
                const messages = await request.json() as { camera_id: string };
                if (!messages.camera_id) {
                    throw new Error('Camera ID is required');
                }

                const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${messages.camera_id}`;
                const response = await this.cameraAnalysisService.analyzeSingleCamera(
                    messages.camera_id,
                    {
                        success: true,
                        snapshot_url: snapshotUrl,
                        snapshot_base64: await getBase64Snapshot(snapshotUrl, messages.camera_id)
                    },
                    `${this.env.HASSIO_URL}/api/camera_proxy_stream/${messages.camera_id}`,
                    'security_analysis'
                );
                return new Response(JSON.stringify(response), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not Found', { status: 404 });
        } catch (error: unknown) {
            console.error('Security worker error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const errorCause = error instanceof Error ? error.cause : 'Security worker error';

            return new Response(JSON.stringify({
                error: errorMessage,
                details: errorCause
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}
```

# File: services/hassio.service.ts

```typescript
import { EntityStateUpdate, Env, HomeAssistantDeviceState, HomeAssistantProxy, IntentData } from '../types';
import { getCameraInfo } from '../utils/camera';

export class HassioApiService {
    private homeAssistantProxy: HomeAssistantProxy;

    constructor(homeAssistantProxy: HomeAssistantProxy) {
        this.homeAssistantProxy = homeAssistantProxy;
    }

    /**
     * Helper method to handle API requests with error handling, timeouts, and retries
     */
    private async handleRequest(request: Request, env: Env, retries = 3): Promise<Response> {
        const timeout = 30000; // 30 seconds timeout
        console.log(`Handling API request: ${request.method} ${request.url}`);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await Promise.race([
                    this.homeAssistantProxy.proxyToHomeAssistant(request, env),
                    new Promise<Response>((_, reject) =>
                        setTimeout(() => reject(new Error('Request timeout')), timeout)
                    )
                ]);

                // For non-ok responses, we want to pass through the error response
                if (!response.ok) {
                    const errorResponse = await response.clone();
                    try {
                        const errorData = await errorResponse.json();
                        return new Response(JSON.stringify({
                            success: false,
                            error: errorData || 'Home Assistant request failed',
                            status: response.status,
                            details: errorData
                        }), {
                            status: response.status,
                            headers: {
                                'Content-Type': 'application/json',
                                'Cache-Control': 'no-store'
                            }
                        });
                    } catch {
                        // If we can't parse the error response, return the original
                        return response;
                    }
                }

                return response;
            } catch (error) {
                const isLastAttempt = attempt === retries;
                const isTimeout = error instanceof Error && error.message === 'Request timeout';

                console.error(`Home Assistant API error (attempt ${attempt}/${retries}):`, error);

                if (isLastAttempt) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            error: isTimeout ? "Request timed out" : "Request failed",
                            details: error instanceof Error ? error.message : String(error),
                            attempt: attempt
                        }),
                        {
                            status: isTimeout ? 504 : 502,
                            headers: {
                                "Content-Type": "application/json",
                                "Cache-Control": "no-store",
                                "X-Retry-Attempts": attempt.toString()
                            }
                        }
                    );
                }

                // Exponential backoff before retry
                await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 5000)));
            }
        }

        // This should never be reached due to the return in the last retry attempt
        throw new Error('Unreachable code');
    }

    // Basic API methods
    async getApiStatus(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getConfig(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/config`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getEvents(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/events`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getServices(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/services`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getHistory(env: Env, timestamp?: string): Promise<Response> {
        const endpoint = timestamp ? `/api/history/period/${timestamp}` : '/api/history/period';
        const request = new Request(`${env.HASSIO_URL}${endpoint}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getLogbook(env: Env, timestamp?: string): Promise<Response> {
        const endpoint = timestamp ? `/api/logbook/${timestamp}` : '/api/logbook';
        const request = new Request(`${env.HASSIO_URL}${endpoint}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getStates(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/states`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getEntityState(env: Env, entityId: string): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/states/${entityId}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    // State updates
    async postEntityState(env: Env, entityId: string, state: string, attributes?: Record<string, any>): Promise<Response> {
        if (!entityId || !state) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Entity ID and state are required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const stateUpdate: EntityStateUpdate = {
            state,
            attributes: attributes || {}
        };

        const request = new Request(`${env.HASSIO_URL}/api/states/${entityId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stateUpdate)
        });

        return this.handleRequest(request, env);
    }

    // Event handling
    async postEvent(env: Env, eventType: string, eventData?: Record<string, any>): Promise<Response> {
        if (!eventType) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Event type is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/events/${eventType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData || {})
        });

        return this.handleRequest(request, env);
    }

    // Service calls
    async postServiceCall(env: Env, domain: string, service: string, serviceData?: Record<string, any>): Promise<Response> {
        if (!domain || !service) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Domain and service are required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(serviceData || {})
        });

        return this.handleRequest(request, env);
    }

    // Template rendering
    async postTemplate(env: Env, template: string): Promise<Response> {
        if (!template) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Template string is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/template`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template })
        });

        return this.handleRequest(request, env);
    }

    // Configuration validation
    async postCheckConfig(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/config/core/check_config`, {
            method: 'POST'
        });

        return this.handleRequest(request, env);
    }

    // Intent handling
    async postHandleIntent(env: Env, intentData: IntentData): Promise<Response> {
        if (!intentData.name) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Intent name is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/intent/handle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intentData)
        });

        return this.handleRequest(request, env);
    }

    // Direct proxy method
    async proxyToHomeAssistant(request: Request, env: Env): Promise<Response> {
        // Instead of creating circular reference, use handleRequest directly
        return this.handleRequest(request, env);
    }
}```

# File: services/openapi.service.ts

```typescript
/**
 * @fileoverview OpenAPI specification service for custom GPT integration
 * Generates and maintains OpenAPI documentation that can be consumed by GPT models
 */

import { OpenAPISpec, OpenAPIPath } from '../types';

export class OpenAPIService {
    /**
     * Generates complete OpenAPI specification for the worker
     * @returns OpenAPI specification object
     */
    generateSpec(): OpenAPISpec {
        return {
            openapi: '3.0.0',
            info: {
                title: 'Home Assistant Worker API',
                version: '1.0.0',
                description: 'API for interacting with Home Assistant through Cloudflare Worker'
            },
            servers: [
                {
                    url: 'https://hassio-api.workers.dev',
                    description: 'Production API'
                }
            ],
            security: [
                { ApiKeyAuth: [] },
                { BearerAuth: [] }
            ],
            components: {
                securitySchemes: {
                    ApiKeyAuth: {
                        type: 'apiKey',
                        in: 'header',
                        name: 'X-Api-Key',
                        description: 'API key for worker-specific endpoints'
                    },
                    BearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                        description: 'Bearer token for Home Assistant endpoints'
                    }
                },
                schemas: {
                    WebSocketMessage: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: ['subscribe', 'unsubscribe', 'ping', 'pong']
                            },
                            entities: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of entity IDs for subscription'
                            }
                        }
                    },
                    CameraAnalysisResult: {
                        type: 'object',
                        properties: {
                            camera_id: { type: 'string' },
                            description: { type: 'string' },
                            snapshot_url: { type: 'string' },
                            stream_url: { type: 'string' },
                            snapshot_base64: { type: 'string' },
                            timestamp: { type: 'string' },
                            metadata: {
                                type: 'object',
                                properties: {
                                    location: { type: 'string' },
                                    floor: { type: 'string' },
                                    group: { type: 'string' },
                                    key_zones: {
                                        type: 'array',
                                        items: { type: 'string' }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            paths: {
                '/api/websocket': {
                    get: {
                        summary: 'Establish WebSocket connection for real-time updates',
                        description: 'Upgrades the connection to WebSocket for receiving real-time entity state updates. Limited to 100 concurrent clients with 30-second ping interval.',
                        responses: {
                            '101': {
                                description: 'WebSocket connection established successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/WebSocketMessage'
                                        }
                                    }
                                }
                            },
                            '503': {
                                description: 'Too many connections (max 100 clients)'
                            }
                        }
                    }
                },
                '/api/states/{entity_id}': {
                    get: {
                        summary: 'Get state of an entity',
                        parameters: [
                            {
                                name: 'entity_id',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Entity ID (e.g., light.living_room)'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Entity state retrieved successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                entity_id: { type: 'string' },
                                                state: { type: 'string' },
                                                attributes: { type: 'object' },
                                                last_changed: { type: 'string' },
                                                last_updated: { type: 'string' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    post: {
                        summary: 'Update state of an entity',
                        parameters: [
                            {
                                name: 'entity_id',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Entity ID to update'
                            }
                        ],
                        requestBody: {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            state: { type: 'string' },
                                            attributes: { type: 'object' }
                                        },
                                        required: ['state']
                                    }
                                }
                            }
                        },
                        responses: {
                            '200': {
                                description: 'Entity state updated successfully'
                            }
                        }
                    }
                },
                '/api/services/{domain}/{service}': {
                    post: {
                        summary: 'Call a Home Assistant service',
                        parameters: [
                            {
                                name: 'domain',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Service domain (e.g., light, switch)'
                            },
                            {
                                name: 'service',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Service name (e.g., turn_on, turn_off)'
                            }
                        ],
                        requestBody: {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            entity_id: { type: 'string' },
                                            service_data: { type: 'object' }
                                        }
                                    }
                                }
                            }
                        },
                        responses: {
                            '200': {
                                description: 'Service called successfully'
                            }
                        }
                    }
                },
                '/api/camera/analyze': {
                    get: {
                        summary: 'Analyze camera feed(s)',
                        parameters: [
                            {
                                name: 'camera_id',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Optional camera ID to analyze. If not provided, analyzes all cameras.'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/CameraAnalysisResult'
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '/api/camera/analyze/group/{group}': {
                    get: {
                        summary: 'Analyze cameras in a specific group',
                        parameters: [
                            {
                                name: 'group',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Camera group to analyze (e.g., garage, entrance)'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Group camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/CameraAnalysisResult'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '/api/camera/analyze/use-case/{use_case}': {
                    get: {
                        summary: 'Analyze cameras for a specific use case',
                        parameters: [
                            {
                                name: 'use_case',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Use case to filter cameras (e.g., security_monitoring, pet_monitoring)'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Use case camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/CameraAnalysisResult'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }

    /**
     * Endpoint handler for serving OpenAPI spec
     * @param request - Incoming HTTP request
     * @returns Response with OpenAPI specification
     */
    async handleRequest(request: Request): Promise<Response> {
        try {
            const spec = this.generateSpec();
            return new Response(JSON.stringify(spec, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'max-age=3600'
                }
            });
        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Failed to generate OpenAPI specification',
                details: error
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    /**
     * Updates paths in the OpenAPI specification
     * @param newPaths - New path definitions to add/update
     * @returns Updated OpenAPI specification
     */
    updatePaths(newPaths: Record<string, Record<string, OpenAPIPath>>): OpenAPISpec {
        const spec = this.generateSpec();
        spec.paths = {
            ...spec.paths,
            ...newPaths
        };
        return spec;
    }
}
```

# File: types/itty-router-extras.d.ts

```typescript
declare module 'itty-router-extras' {
    export function error(status: number, body: any): Response;
    export function json(body: any): Response;
    export function status(code: number, init?: ResponseInit): Response;
    export function text(body: string, init?: ResponseInit): Response;
}
```

# File: types/analysis.ts

```typescript
import { PromptLibrary, PromptType } from '../types';

export interface CustomAnalysisRequest {
    prompt_template: {
        devices: string[];  // List of device IDs to analyze
        prompt: string;     // Custom analysis prompt
    }
}

export interface AnalysisResponse {
    success: boolean;
    request_id: string;
    results: {
        device_id: string;
        analysis: string;
        timestamp: string;
        snapshot_url?: string;
        state?: any;
    }[];
    error?: string;
    details?: any;
}

export interface DeviceAnalysisData {
    device_id: string;
    snapshot_base64?: string;
    snapshot_url?: string;
    state?: any;
}

export interface AnalysisContext {
    devices: DeviceAnalysisData[];
    prompt: string;
    prompt_type?: PromptType;
    category?: string;
    request_id: string;
}
```

# File: utils/camera.ts

```typescript
/**
 * Utility module for managing structured AI prompts based on the type of query.
 * This version organizes security-related analysis into structured queries.
 */
import { HassioApiService } from '../services/hassio.service';
import { CameraMetadata, CameraOrganization, CameraSnapshotResponse, Env, HomeAssistantDeviceState } from '../types';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { arrayBufferToBase64 } from '../utils/tools';

export const CAMERA_METADATA: Record<string, CameraMetadata> = {
  "camera.garage": {
    "camera_id": "camera.garage",
    "description": "Dual-purpose garage monitoring camera (1920x1080, 25fps) covering both interior hallway door and main street-level garage door (connects to driveway.camera coverage area). Critical monitoring points: vehicle presence/absence, garage door status, Wednesday trash removal confirmation. Camera provides essential security coverage for both home access points and vehicle storage area.",
    "location": "exterior",
    "floor": "garage",
    "group": "garage",
    "key_zones": ["garage", "driveway"],
    "use_case": ["vehicle presence detection", "door status monitoring", "security monitoring", "trash day confirmation", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
  },
  "camera.guest_bedroom": {
    "camera_id": "camera.guest_bedroom",
    "description": "Specialized monitoring camera focused on environmental concerns: water damage detection and rodent activity surveillance. Coverage includes sliding glass door to patio (overlaps with camera.patio coverage). Primary purpose is property protection through early detection of water intrusion or pest activity.",
    "location": "interior",
    "floor": "downstairs",
    "group": "bedroom",
    "key_zones": ["patio", "guest bedroom"],
    "use_case": ["water leak detection", "rodent activity monitoring", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.entry": {
    "camera_id": "camera.entry",
    "description": "High-resolution entrance camera (2688x1512, 30fps, enhanced bitrate) mounted above front door overlooking entry gate (complementing camera.doorbell coverage). Monitors vestibule area between entry gate and front door. Critical for package security monitoring once deliveries are inside locked gate. Forms monitoring triangle with camera.doorbell (front) and camera.lobby (interior door view) for comprehensive entrance security coverage.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["entry", "doorbell", "lobby"],
    "use_case": ["package security", "entrance monitoring", "motion detection", "person detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.driveway": {
    "camera_id": "camera.driveway",
    "description": "High-performance security camera (1920x1080, 50fps, high bitrate) monitoring driveway, sidewalk, and street. Works in conjunction with camera.doorbell for security monitoring. Critical features: vehicle license plate capture capability, suspect/vehicle description detail for security incidents. Important for monitoring: package theft attempts, delivery vehicle verification, contractor vehicle documentation, guest vehicle tracking. Enhanced frame rate supports clear motion capture of moving vehicles.",
    "location": "exterior",
    "floor": "front of house",
    "group": "driveway",
    "key_zones": ["driveway", "street", "sidewalk"],
    "use_case": ["license plate recognition", "vehicle identification", "security monitoring", "package theft prevention", "motion detection", "visitor detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.downstairs_living_room": {
    "camera_id": "camera.downstairs_living_room",
    "description": "High-resolution interior camera (2688x1512, 30fps) focused on sliding glass door patio access (corresponding with camera.patio exterior view). Primary monitoring point for dog indoor/outdoor transitions - main access point for pet potty breaks, play time, and outdoor investigation. Strategic positioning provides comprehensive coverage of main lower-level access point.",
    "location": "interior",
    "floor": "downstairs",
    "group": "living room",
    "key_zones": ["patio", "downstairs living room"],
    "use_case": ["pet monitoring", "door monitoring", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.grass_patch": {
    "camera_id": "camera.grass_patch",
    "description": "Exterior camera (1920x1080, 25fps) monitoring back property area. Primary monitoring zone for dog activities including potty breaks, play sessions, and investigative behavior. Important for wildlife monitoring - common sightings include mice, cats, and coyotes which may pose safety concerns for pets. Requires regular monitoring for potential wildlife threats.",
    "location": "exterior",
    "floor": "backyard",
    "group": "backyard",
    "key_zones": ["grass patch", "backyard"],
    "use_case": ["pet monitoring", "wildlife monitoring", "motion detection", "security monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.patio": {
    "camera_id": "camera.patio",
    "description": "Exterior camera overlooking patio area with view of lower level living room and guest bedroom sliding glass doors. Dogs primarily use right-side lower level living room sliding door for outdoor access. Notable positioning: forms monitoring pair with camera.downstairs_living_room (interior camera) - both cameras face opposite directions at same access point. Coverage area includes dog activity zones and potential wildlife areas.",
    "location": "exterior",
    "floor": "downstairs",
    "group": "patio",
    "key_zones": ["patio", "downstairs living room", "guest bedroom"],
    "use_case": ["pet monitoring", "security monitoring", "motion detection", "door monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.roof": {
    "camera_id": "camera.roof",
    "description": "Elevated exterior camera (2688x1512, 30fps, enhanced bitrate) mounted above primary bathroom skylight, aligned with camera.driveway direction. Primary purpose: monitoring flat roof drainage system, specifically roof drain and nearby vent. Critical for maintenance monitoring: alert if standing water persists beyond 48 hours, which risks roof leaks and warranty violations. Secondary monitoring: wildlife activity and human presence on adjacent or own roofing.",
    "location": "exterior",
    "floor": "roof",
    "group": "roof",
    "key_zones": ["roof", "driveway"],
    "use_case": ["roof drainage monitoring", "wildlife monitoring", "security monitoring", "water detection", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.lobby": {
    "camera_id": "camera.lobby",
    "description": "Interior camera (1920x1080, 30fps) monitoring the main lobby entrance area. Field of view includes three key areas: front door, garage hallway door, and upstairs staircase. Critical for monitoring resident and guest movement patterns. Notable behavior pattern: dogs typically wait by front door or garage hallway door when owners are away, providing indirect occupancy indication.",
    "location": "interior",
    "floor": "downstairs",
    "group": "lobby",
    "key_zones": ["lobby", "front door", "garage hallway"],
    "use_case": ["occupancy detection", "security monitoring", "motion detection", "pet monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.upstairs_living_room": {
    "camera_id": "camera.upstairs_living_room",
    "description": "Primary living space camera (2688x1512, 30fps) monitoring the upstairs area above garage. Field of view encompasses multiple zones: main TV/couch area, partial kitchen view behind couch, dining space at couch's end, stairwell from camera.lobby, and partial view of hallway leading to offices/bedrooms (sequence: Jason's office, primary bedroom, Justin's office, guest hall bath). Important to monitor dog behavior when owners are away.",
    "location": "interior",
    "floor": "upstairs",
    "group": "living room",
    "key_zones": ["upstairs living room", "lobby", "kitchen"],
    "use_case": ["pet monitoring", "occupancy detection", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.doorbell": {
    "camera_id": "camera.doorbell",
    "description": "Primary front entrance monitoring camera (1600x1200) with motion detection. Positioned facing the street with camera.driveway 20ft to the left. Identifies delivery service by uniforms and vehicles: brown UPS uniforms/trucks, blue/purple FedEx uniforms with white/purple trucks, yellow/red DHL uniforms with yellow trucks, Amazon blue vests with branded vans, USPS blue uniforms with white trucks. Food delivery identified by branded bags. Critical for security and delivery monitoring.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["doorbell", "driveway", "street"],
    "use_case": ["delivery service identification", "person likely of ringing doorbell approaching", "security monitoring", "package theft", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.package": {
    "camera_id": "camera.package",
    "description": "Specialized downward-facing package monitoring camera (1600x1200, 2fps) mounted under camera.doorbell. Identifies delivery type: Amazon (blue/black tape with smile logo), UPS (brown boxes), FedEx (white/purple packages), DHL (yellow packaging), USPS (white/blue packages). Food deliveries appear as branded paper/plastic bags or thermal bags. Package size and branding helps determine urgency.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["package", "doorbell"],
    "use_case": ["package identification", "delivery confirmation", "security monitoring", "package theft", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
  }
};

/**
 * Retrieves structured camera metadata, merging it with Home Assistant state data.
 */
export async function getCameraInfo(
    env: Env,
    apiService: HassioApiService,
    cameraId?: string
): Promise<CameraMetadata | CameraMetadata[]> {
    if (cameraId) {
        return await getSingleCameraInfo(env, apiService, cameraId);
    }

    return await getAllCamerasInfo(env, apiService);
}

/**
 * Fetches metadata for a single camera, merging Home Assistant state data.
 */
async function getSingleCameraInfo(env: Env, apiService: HassioApiService, cameraId: string): Promise<CameraMetadata> {
    try {
        const response = await apiService.getEntityState(env, cameraId);
        if (!response.ok) {
            throw new Error(`Failed to fetch camera state: ${response.status}`);
        }

        const cameraState = await response.json() as HomeAssistantDeviceState;
        const metadata = CAMERA_METADATA[cameraId] ?? createDefaultMetadata(cameraId);

        return mergeMetadataWithState(metadata, cameraState);
    } catch (error) {
        console.error(`Error retrieving metadata for camera ${cameraId}:`, error);
        return createDefaultMetadata(cameraId, "Failed to retrieve metadata.");
    }
}

/**
 * Fetches metadata for all cameras with state data and snapshots.
 */
async function getAllCamerasInfo(env: Env, apiService: HassioApiService): Promise<CameraMetadata[]> {
    const cameraEntries = Object.entries(CAMERA_METADATA) as [string, CameraMetadata][];

    const cameraPromises = cameraEntries.map(async ([cameraId, metadata]) => {
        try {
            const response = await apiService.getEntityState(env, cameraId);
            if (!response.ok) {
                throw new Error(`Failed to fetch camera state: ${response.status}`);
            }

            const cameraState = await response.json() as HomeAssistantDeviceState;

            let snapshot_success = false;
            let snapshot_url = `${env.HASSIO_URL}/api/camera_proxy/${cameraId}`;
            let snapshot_base64 = '';

            try {
                const snapshotResponse = await getBase64Snapshot(snapshot_url, cameraId);
                if (snapshotResponse) {
                    snapshot_success = true;
                    snapshot_base64 = snapshotResponse;
                }
            } catch (error) {
                console.error(`Failed to fetch snapshot for ${cameraId}:`, error);
            }

            const snapshot_data: CameraSnapshotResponse = {
                success: snapshot_success,
                snapshot_url,
                snapshot_base64
            };

            return {
                ...metadata,
                camera_id: cameraState.entity_id,
                state: cameraState.state,
                attributes: {
                    ...cameraState.attributes,
                    description: metadata.description,
                    location: metadata.location,
                    floor: metadata.floor,
                    group: metadata.group,
                    key_zones: metadata.key_zones,
                    use_case: metadata.use_case,
                    last_reported: new Date().toISOString()
                },
                snapshot_data
            };
        } catch (error) {
            console.error(`Error retrieving metadata for camera ${cameraId}:`, error);
            return createDefaultMetadata(cameraId);
        }
    });

    return await Promise.all(cameraPromises);
}

/**
 * Merges Home Assistant state data into camera metadata.
 */
function mergeMetadataWithState(metadata: CameraMetadata, cameraState: HomeAssistantDeviceState): CameraMetadata {
    return {
        ...metadata,
        camera_id: cameraState.entity_id,
        state: cameraState.state,
        attributes: {
            ...cameraState.attributes,
            description: metadata.description,
            location: metadata.location,
            floor: metadata.floor,
            group: metadata.group,
            key_zones: metadata.key_zones,
            use_case: metadata.use_case,
            last_reported: new Date().toISOString()
        }
    };
}

/**
 * Creates a default camera metadata entry.
 */
function createDefaultMetadata(cameraId: string, description: string = "Unknown camera. No metadata found."): CameraMetadata {
    return {
        camera_id: cameraId,
        description,
        state: "unknown",
        location: "exterior",
        floor: "front of house",
        group: "unknown",
        key_zones: [],
        use_case: [],
        attributes: {
            description,
            location: "exterior",
            floor: "front of house",
            group: "unknown",
            key_zones: [],
            use_case: [],
            last_reported: new Date().toISOString()
        },
        snapshot_data: {
            success: false,
            snapshot_url: "",
            snapshot_base64: ""
        }
    };
}

/**
 * Retrieves all cameras belonging to a key zone.
 */
export function getCamerasByZone(zone: string): CameraMetadata[] {
    return (Object.entries(CAMERA_METADATA) as [string, CameraMetadata][])
        .filter(([_, data]) => data.key_zones.includes(zone))
        .map(([id, data]) => ({
            ...data,
            camera_id: id
        }));
}

/**
 * Retrieves cameras based on a given use case.
 */
export async function getCamerasByUseCase(
    env: Env,
    apiService: HassioApiService,
    useCase: string
): Promise<CameraMetadata[]> {
    const allCameras = await getAllCamerasInfo(env, apiService);
    return allCameras.filter(camera => camera.use_case.includes(useCase));
}

/**
 * Retrieves all available use cases.
 */
export function getAvailableUseCases(): string[] {
    const useCases = new Set<string>();
    (Object.values(CAMERA_METADATA) as CameraMetadata[]).forEach(camera => {
        camera.use_case.forEach(useCase => useCases.add(useCase));
    });
    return Array.from(useCases);
}

/**
 * Builds a structured organization of cameras.
 */
export function buildCameraOrganization(env?: Env): CameraOrganization {
    const organization: CameraOrganization = {
        use_case: {},
        location: {},
        floor: {},
        group: {}
    };

    (Object.entries(CAMERA_METADATA) as [string, CameraMetadata][]).forEach(([cameraId, metadata]) => {
        // Organize by use_case
        metadata.use_case.forEach(useCase => {
            if (!organization.use_case[useCase]) {
                organization.use_case[useCase] = [];
            }
            organization.use_case[useCase].push(cameraId);
        });

        // Organize by location
        if (metadata.location) {
            if (!organization.location[metadata.location]) {
                organization.location[metadata.location] = [];
            }
            organization.location[metadata.location].push(cameraId);
        }

        // Organize by floor
        if (metadata.floor) {
            if (!organization.floor[metadata.floor]) {
                organization.floor[metadata.floor] = [];
            }
            organization.floor[metadata.floor].push(cameraId);
        }

        // Organize by group
        if (metadata.group) {
            if (!organization.group[metadata.group]) {
                organization.group[metadata.group] = [];
            }
            organization.group[metadata.group].push(cameraId);
        }
    });

    return organization;
}

/**
 * Retrieves cameras based on a specific monitoring group.
 */
export async function getCamerasByGroup(
    env: Env,
    apiService: HassioApiService,
    group: string
): Promise<CameraMetadata[]> {
    const allCameras = await getAllCamerasInfo(env, apiService);
    return allCameras.filter(camera => camera.group === group);
}

/**
 * Fetches a snapshot and converts it to Base64.
 */
export async function getBase64Snapshot(snapshotUrl: string, cameraId: string): Promise<string> {
    try {
        const response = await fetch(snapshotUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch snapshot: ${response.status} - ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return arrayBufferToBase64(arrayBuffer);
    } catch (error) {
        console.error(`Error getting base64 snapshot for camera ${cameraId}:`, error);
        throw error;
    }
}
```

# File: utils/prompts.ts

```typescript
import { PromptCategory, PromptLibrary, PromptType } from '../types';

/**
 * Structured AI Prompts categorized by type.
 */
export const PROMPT_LIBRARY: PromptLibrary = {
    general_status: {
        devices: [
            'camera.doorbell',
            'camera.driveway',
            'camera.entry',
            'camera.package',
            'camera.garage',
            'camera.upstairs_living_room',
            'camera.downstairs_living_room',
            'camera.patio',
            'camera.roof',
            'camera.grass_patch',
            'camera.lobby'
        ],
        description: "Provide a general status update for any camera in the system",
        prompt: `Analyze the camera feed and provide a concise status update based on the camera's location:

            Entry Points (doorbell, driveway, entry):
            - Is anyone approaching or present?
            - Are there any vehicles moving or parked?
            - Are there any packages visible?

            Indoor Areas (upstairs/downstairs living room, lobby):
            - Are any people or pets present?
            - What is their general activity?

            Outdoor Areas (patio, grass patch):
            - Are any people or pets present?
            - Is there any notable activity?
            - For patio: Is the door open/closed?

            Specialized Areas:
            - Garage: Vehicle presence? Door open/closed?
            - Package Area: Any packages present? Brief description?
            - Roof: Any visible issues or water pooling?

            Keep responses brief and focused. If nothing significant is happening, report 'nothing meaningful'.`
    },
    security_analysis: {
        entry_points: {
            devices: ['camera.doorbell', 'camera.driveway', 'camera.entry'],
            description: "Detect if anyone is at the entry points (doorbell, driveway, or entry cameras).",
            prompt: "Analyze camera.doorbell, camera.entry, and camera.driveway. Identify if someone is present, describe their appearance, and determine if they are a delivery person."
        },
        package_detection: {
            devices: ['camera.package'],
            description: "Detect packages at the doorstep.",
            prompt: "Analyze camera.package. Identify if a package is present and describe its appearance (Amazon-branded, plain box, food delivery, etc.)."
        },
        vehicle_monitoring: {
            devices: ['camera.driveway', 'camera.garage'],
            description: "Monitor vehicle presence in the driveway and garage.",
            prompt: `Analyze camera.driveway and camera.garage.
                - Detect if a car is parked or blocking the driveway.
                - Extract vehicle details: make, model, color, and license plate.
                - Detect if a car is inside the garage and if the garage door is open or closed.`
        },
        indoor_monitoring: {
            devices: ['camera.upstairs_living_room', 'camera.downstairs_living_room', 'camera.patio'],
            description: "Monitor indoor activity (people, pets, and cleaning robots).",
            prompt: `Analyze indoor cameras: camera.upstairs_living_room, camera.downstairs_living_room, camera.patio.
                - Detect and describe any people present.
                - Identify if any dogs are present (French Bulldog, Corgi, etc.).
                - Describe dog activity (playing, sleeping, barking).
                - Identify cleaning robots and determine if they are operating normally or stuck.`
        },
        roof_monitoring: {
            devices: ['camera.roof'],
            description: "Check the roof for water pooling and damage.",
            prompt: `Analyze camera.roof.
                - Detect any standing water.
                - Estimate the percentage of the roof affected.
                - Identify the location (puddles near drains, along roof edges, etc.).`
        },
        door_status: {
            devices: ['sensor.front_door_lock', 'sensor.back_door_lock', 'sensor.garage_entry_lock'],
            description: "Check the status of all entry doors in the home.",
            prompt: `Perform a security check on all entry doors using Home Assistant door lock sensors.
                - **Verify door lock status** for all exterior doors [excluding "Betsy" doors entirely]
                - If any door is **unlocked**, list the specific unlocked doors.
                - If all doors are **securely locked**, confirm security status.

                **🔄 Auto-Locking Logic:**
                - **Daytime (Sun is Up ☀️):** Auto-lock any unlocked door that has been open for **15+ minutes**.
                - **Nighttime (After Sunset 🌙):** Auto-lock any unlocked door **immediately (0+ minutes open).**
                - **If a door was auto-locked**, notify the user with:
                    🔒 "The [front/back/garage] door was left unlocked for X minutes. Auto-locking for security."
                - **If auto-locking failed**, notify the user with:
                    ⚠️ "Warning! Attempted to lock the [front/back/garage] door, but it failed. Please check manually."

                **🚨 Alert & Notification Triggers:**
                - If the system is in **'away' mode** and **any door is unlocked**, send a **high-priority security alert**.
                - If a door is **auto-locked**, log the action and notify the user.
                - If an auto-lock attempt **fails**, notify the user to take action.

                **Additional Considerations:**
                - If door sensors indicate the **door is open**, prevent auto-locking and notify the user.
                - Log all **auto-lock events & failures** in Home Assistant for security auditing.`
        },
        garage_monitoring: {
            devices: ['camera.garage', 'sensor.garage_door', 'sensor.tesla_wall_connector_status', 'sensor.betsy_charging', 'device_tracker.betsy_location', 'binary_sensor.betsy_charger', 'device_tracker.betsy_location_tracker', 'sensor.betsy_data_last_update_time', 'button.betsy_wake_up', 'button.betsy_wake'],
            description: "Monitor garage security and car presence using both cameras and Tesla API sensors.",
            prompt: `Perform a comprehensive garage and driveway security analysis using:
                - **Camera Data:** camera.garage (inside garage), camera.driveway (driveway view)
                - **Tesla API Sensors:** Real-time vehicle location, charging status, and door state.

                **Vehicle Details:**
                - The homeowners own a **2019 Black Tesla Model 3** nicknamed **"Betsy"**.
                - Prioritize identifying "Betsy" using both **camera images** and **Tesla API vehicle location data**.

                **Garage Monitoring (4 Conditions):**
                - 🚨  "Betsy" is **inside the garage** & **garage door is open** → Set input_boolean.garage_door_open_with_car.
                - ✅ "Betsy" is **inside the garage** & **garage door is closed** → Set input_boolean.garage_door_closed_with_car.
                - 🚨  "Betsy" is **NOT in the garage** & **garage door is open** → Set input_boolean.garage_door_open_without_car.
                - ✅ "Betsy" is **NOT in the garage** & **garage door is closed** → Set input_boolean.garage_door_closed_without_car.

                **Driveway Monitoring (4 Conditions):**
                - 🚨  "Betsy" is **in the driveway** & **garage door is open** → Set input_boolean.garage_door_open_car_parked_driveway.
                - ✅ "Betsy" is **in the driveway** & **garage door is closed** → Set input_boolean.garage_door_closed_car_parked_driveway.
                - 🚨  "Betsy" is **NOT in the driveway** & **garage door is open** → Set input_boolean.garage_door_open_driveway_clear.
                - ✅ "Betsy" is **NOT in the driveway** & **garage door is closed** → Set input_boolean.garage_door_closed_driveway_clear.

                **Real-time Alert Triggers:**
                - 🚨 If "Betsy" **is parked outside (driveway or street)** but **garage door is open**, notify user.
                - 🚨 If "Betsy" **is actively charging** using the **home charger**, ensure **garage door is securely closed**.
                - 🚨 If "Betsy" **is plugged into the charger but not charging**, notify user to check for charging issues.
                - 🚨 If **any vehicle is parked in the garage**, but the **garage door remains open for 5+ minutes**, send a reminder.
                - 🚨 If **no vehicle is parked in the garage**, and the **garage door remains open for 30+ seconds**, notify user & auto-close.

                **Additional Considerations:**
                - 🏠 Home Assistant should **automatically close the garage door** if it's left open and no car is detected.
                - 🛠️ If Tesla API data conflicts with camera data, prioritize Tesla GPS location for accuracy.
                - 📊 Store logs of garage door actions & vehicle presence for **security review**.`
        },
        automated_security_sweep: []
    },
    pet_monitoring: {
        dog_monitoring: {
            devices: [
                "camera.upstairs_living_room",
                "camera.lobby",
                "camera.downstairs_living_room",
                "camera.patio",
                "camera.grass_patch"
            ],
            description: "Monitors the activity and behavior of two dogs, Louis (Brindle French Bulldog) and Ollie (Tri-Color Corgi), across various rooms to track their movement, play, potty habits, and potential health concerns.",
            prompt: `Analyze the security cameras for dog activity. Focus on the two dogs in the home:

                - **Louis (Brindle French Bulldog)**
                - **Ollie (Tri-Color Corgi)**

                📍 **Room-Specific Monitoring:**
                1️⃣ **Upstairs Living Room (camera.upstairs_living_room)**
                    - Are the dogs eating, laying on the couch, walking around, or sitting by the stairs?
                2️⃣ **Lobby (camera.lobby)**
                    - Are the dogs waiting by the door?
                    - Are they showing signs of needing to go outside?
                3️⃣ **Downstairs Living Room (camera.downstairs_living_room)**
                    - Are the dogs walking around?
                    - Are the dogs outside waiting by the glass door to come in?
                4️⃣ **Patio & Grass Patch (camera.patio & camera.grass_patch)**
                    - Are the dogs outside?
                    - If yes, are they using the potty?
                    - Which dog(s) used the potty and where?
                    - Are they playing? If so, describe their play behavior.

                🚨 **Behavior Alerts (Any Room)**
                - Are either dog(s) **using the bathroom inside**? Which dog(s)?
                - 🚨 Is there **evidence of peeing, pooping, or throwing up**? Which dog(s)?
                - Is either dog **licking excessively**? If so, which dog?
                - 🚨 **Any concerning health behaviors?** If yes, describe the issue.

                📌 **Important Instructions:**
                - **Describe dog activity clearly** based on room location.
                - **If a concerning behavior is detected, alert the user**.
                - **Provide a summary of each dog's actions** with timestamps where possible.`
        }
    },
    robot_monitoring: {},
    data_analysis: {}
};

// Type guard to check if an object is a PromptCategory
function isPromptCategory(obj: any): obj is PromptCategory {
    return obj &&
           typeof obj === 'object' &&
           'devices' in obj &&
           'description' in obj &&
           'prompt' in obj &&
           Array.isArray(obj.devices);
}

/**
 * Dynamically build category and pattern maps for prompt lookup across all registered prompt types.
 */
const categoryMap: Record<string, { type: PromptType; category: keyof PromptLibrary[PromptType] }> = {};
const patternMap: [RegExp, { type: PromptType; category: keyof PromptLibrary[PromptType] }][] = [];

// Iterate through all registered prompt categories
for (const [promptType, categories] of Object.entries(PROMPT_LIBRARY) as [PromptType, PromptLibrary[PromptType]][]) {
    for (const [category, promptData] of Object.entries(categories)) {
        if (isPromptCategory(promptData)) {
            // Add exact device mappings
            for (const device of promptData.devices) {
                categoryMap[device] = { type: promptType as PromptType, category: category as keyof PromptLibrary[PromptType] };
            }

            // Add pattern-based mappings
            const devicePatterns = promptData.devices.map(device => device.replace(/\./g, '\\.'));
            const regexPattern = new RegExp(`^(${devicePatterns.join('|')})$`);
            patternMap.push([
                regexPattern,
                { type: promptType as PromptType, category: category as keyof PromptLibrary[PromptType] }
            ]);
        }
    }
}

/**
 * Determines the appropriate prompt categories based on a given camera or sensor ID.
 * @param entityId - The entity ID of the camera or sensor
 * @param categoryType - Optional filter for a specific prompt type
 * @returns An array of matching prompt categories
 */
export function getPromptCategoryForCamera<T extends keyof PromptLibrary>(
    entityId: string,
    categoryType?: T
): { type: T; category: keyof PromptLibrary[T] }[] {
    let matches: { type: keyof PromptLibrary; category: keyof PromptLibrary[keyof PromptLibrary] }[] = [];

    // Exact match lookup in categoryMap
    if (categoryMap[entityId]) {
        matches.push(categoryMap[entityId]);
    }

    // Pattern-based lookup using regex matching
    matches.push(...patternMap
        .filter(([regex]) => regex.test(entityId))
        .map(([, match]) => match)
    );

    // If categoryType is specified, filter results
    if (categoryType) {
        matches = matches.filter(match => match.type === categoryType);
    }

    // Ensure return type matches `T`
    return matches.map(match => ({
        type: match.type as T,
        category: match.category as keyof PromptLibrary[T]
    }));
}

// Populate `automated_security_sweep` dynamically with proper type checking
PROMPT_LIBRARY.security_analysis.automated_security_sweep = Object.entries(PROMPT_LIBRARY.security_analysis)
    .filter(([key, value]) => key !== 'automated_security_sweep' && isPromptCategory(value))
    .map(([, value]) => value as PromptCategory);

/**
 * Retrieves structured prompts for a given category.
 * @param type - The type of prompt category
 * @param category - The subcategory within the type
 * @returns A structured prompt or null if not found
 */
export function getPrompt<T extends PromptType>(
    type: T,
    category: keyof PromptLibrary[T]
): PromptCategory | PromptCategory[] | null {
    if (!PROMPT_LIBRARY[type]) {
        return null;
    }

    const categoryData = PROMPT_LIBRARY[type][category];

    if (!categoryData) {
        return null;
    }

    // Handle array case (like automated_security_sweep)
    if (Array.isArray(categoryData)) {
        return categoryData.filter(isPromptCategory);
    }

    // Handle single prompt case
    if (isPromptCategory(categoryData)) {
        return categoryData;
    }

    return null;
}

// Export the type guard for external use
export { isPromptCategory };
```

# File: utils/response.ts

```typescript
/**
 * @fileoverview Response utility functions for standardizing API responses
 */

/**
 * Creates a JSON response with proper headers
 * @param data - Data to be JSON stringified
 * @param options - Optional Response initialization options
 * @returns Response object with JSON headers
 */
export function json(data: any, options: ResponseInit = {}): Response {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    return new Response(JSON.stringify(data), {
        ...options,
        headers,
    });
}

/**
 * Creates a standardized error response
 * @param status - HTTP status code
 * @param data - Error data (string or object)
 * @returns Response object with error details
 */
export function error(status: number, data: string | Record<string, any>): Response {
    return json(
        {
            success: false,
            error: typeof data === 'string' ? data : data.error || 'Unknown error',
            details: typeof data === 'string' ? undefined : data,
        },
        { status }
    );
}

/**
 * Creates a success response with standardized format
 * @param data - Success response data
 * @param options - Optional Response initialization options
 * @returns Response object with success details
 */
export function success(data: any, options: ResponseInit = {}): Response {
    return json({
        success: true,
        data,
    }, options);
}

/**
 * Creates a redirect response
 * @param url - URL to redirect to
 * @param status - HTTP status code (default: 302)
 * @returns Response object with redirect
 */
export function redirect(url: string, status: number = 302): Response {
    return new Response(null, {
        status,
        headers: {
            Location: url
        }
    });
}

/**
 * Creates a not found response
 * @param message - Optional custom message
 * @returns Response object for 404
 */
export function notFound(message: string = 'Not Found'): Response {
    return error(404, message);
}

/**
 * Creates an unauthorized response
 * @param message - Optional custom message
 * @returns Response object for 401
 */
export function unauthorized(message: string = 'Unauthorized'): Response {
    return error(401, message);
}

/**
 * Creates a forbidden response
 * @param message - Optional custom message
 * @returns Response object for 403
 */
export function forbidden(message: string = 'Forbidden'): Response {
    return error(403, message);
}

/**
 * Creates a bad request response
 * @param message - Optional custom message or error details
 * @returns Response object for 400
 */
export function badRequest(message: string | Record<string, any> = 'Bad Request'): Response {
    return error(400, message);
}

/**
 * Creates a server error response
 * @param message - Optional custom message or error details
 * @returns Response object for 500
 */
export function serverError(message: string | Record<string, any> = 'Internal Server Error'): Response {
    return error(500, message);
}
```

# File: utils/database.ts

```typescript
/**
 * @fileoverview Database utilities for handling D1 database operations
 * This module provides structured database access and logging functionality
 */

import { D1Database, D1Result } from '@cloudflare/workers-types';

/**
 * Ensures the request logging task exists in the database
 * @param db - D1 database instance
 * @returns ID of the logging task
 */
export async function ensureRequestLoggingTask(db: D1Database): Promise<number> {
    const { results } = await db.prepare(`
        SELECT id FROM automation_tasks
        WHERE title = 'Request Logger'
        LIMIT 1
    `).all<{ id: number }>();

    if (results[0]?.id) {
        return results[0].id;
    }

    await db.prepare(`
        INSERT INTO automation_tasks (
            title, description, type, trigger_spec, instructions, is_active, priority
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
        'Request Logger',
        'System task for logging incoming requests',
        'event',
        'request',
        'Log incoming requests to the system',
        true,
        1
    ).run();

    const { results: newResults } = await db.prepare(`
        SELECT id FROM automation_tasks
        WHERE title = 'Request Logger'
        LIMIT 1
    `).all<{ id: number }>();

    return newResults[0]?.id ?? -1;
}

/**
 * Logs an incoming request to the database
 * @param db - D1 database instance
 * @param request - HTTP request to log
 */
export async function logRequest(db: D1Database, request: Request): Promise<void> {
    const url = new URL(request.url);
    const taskId = await ensureRequestLoggingTask(db);

    const headerEntries: [string, string][] = [];
    request.headers.forEach((value, key) => {
        headerEntries.push([key, value]);
    });

    await db.prepare(`
        INSERT INTO automation_logs (
            task_id, execution_id, type, content, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
        taskId,
        crypto.randomUUID(),
        'start',
        `${request.method} ${url.pathname}`,
        JSON.stringify({
            url: request.url,
            headers: Object.fromEntries(headerEntries)
        })
    ).run();
}

/**
 * Queries chat history with optional search and pagination
 * @param db - D1 database instance
 * @param searchQuery - Optional search term
 * @param limit - Maximum number of results to return
 */
export async function queryChatHistory(
    db: D1Database,
    searchQuery?: string,
    limit: number = 100
): Promise<Response> {
    try {
        let query = `
            SELECT c.*, al.content as request_log
            FROM conversations c
            LEFT JOIN automation_logs al ON c.session_id = al.execution_id
            WHERE al.type = 'start'
        `;
        const params: any[] = [];

        if (searchQuery) {
            query += ` AND (c.messages LIKE ? OR al.content LIKE ?)`;
            params.push(`%${searchQuery}%`, `%${searchQuery}%`);
        }

        query += ` ORDER BY c.created_at DESC LIMIT ?`;
        params.push(limit);

        const { results } = await db.prepare(query).bind(...params).all();
        return new Response(JSON.stringify(results), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(JSON.stringify({
            error: 'Error querying chat history',
            details: errorMessage
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Creates necessary database tables if they don't exist
 * @param db - D1 database instance
 */
export async function initializeDatabase(db: D1Database): Promise<void> {
    const migrations = [
        `CREATE TABLE IF NOT EXISTS automation_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            type TEXT NOT NULL,
            trigger_spec TEXT,
            instructions TEXT,
            is_active BOOLEAN DEFAULT true,
            priority INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS automation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            execution_id TEXT NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (task_id) REFERENCES automation_tasks(id)
        )`,
        `CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            messages TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    ];

    for (const migration of migrations) {
        await db.prepare(migration).run();
    }
}
```

# File: utils/tools.ts

```typescript
/**
 * Converts an ArrayBuffer to a Base64 string (Cloudflare Workers-compatible).
 * Uses a TextDecoder approach for better performance in Cloudflare.
 * @param arrayBuffer - The ArrayBuffer to encode.
 * @returns A Base64-encoded string.
 */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert binary data to a string
    const binaryString = String.fromCharCode(...uint8Array);

    // Encode to Base64
    return btoa(binaryString);
}```

# File: utils/homeassistant-proxy.ts

```typescript
import { Env } from '../types';

export async function proxyToHomeAssistant(request: Request, env: Env): Promise<Response> {
    try {
        // Convert headers to a plain object for logging
        const headerObj: Record<string, string> = {};
        request.headers.forEach((value, key) => {
            headerObj[key] = value;
        });

        console.log('Proxying request:', {
            original_url: request.url,
            method: request.method,
            headers: headerObj
        });

        // Parse the original URL to get the path
        const originalUrl = new URL(request.url);
        const targetUrl = new URL(originalUrl.pathname + originalUrl.search, env.HASSIO_URL);

        // Set up headers
        const headers = new Headers(request.headers);
        headers.delete('host');  // Remove host header to prevent conflicts
        headers.set('Authorization', `Bearer ${env.HASSIO_TOKEN}`);

        // Set content-type for requests with bodies
        if (!['GET', 'HEAD'].includes(request.method) && !headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }

        // Create the proxy request
        const proxyRequest = new Request(targetUrl.toString(), {
            method: request.method,
            headers: headers,
            body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        });

        console.log('Sending proxy request to:', targetUrl.toString());

        // Validate URL before making request
        if (!targetUrl.toString().startsWith(env.HASSIO_URL)) {
            throw new Error('Invalid Home Assistant URL');
        }

        // Make the request with a timeout
        const timeoutPromise = new Promise<Response>((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 30000); // 30 second timeout
        });

        const fetchPromise = fetch(proxyRequest).catch(error => {
            console.error('Fetch error:', error);
            throw new Error(`Failed to connect to Home Assistant: ${error.message}`);
        });

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        // Convert response headers to a plain object for logging
        const responseHeaderObj: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaderObj[key] = value;
        });

        console.log('Received response:', {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaderObj
        });

        // If we get here, we have a valid response
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    } catch (error) {
        console.error('Proxy error:', error);

        // Return a properly structured error response
        return new Response(JSON.stringify({
            success: false,
            error: 'Failed to proxy request to Home Assistant',
            details: error instanceof Error ? error.message : String(error)
        }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            }
        });
    }
}
```

# File: utils/model-selector.ts

```typescript
export function selectAIModel(taskType: string): string {
    switch (taskType) {
        case "image_analysis":
        case "camera_security":
        case "object_detection":
        case "garage_monitoring":
        case "roof_inspection":
            return "@cf/meta/llama-3.2-11b-vision-instruct"; // Best for images

        case "text_query":
        case "home_status":
        case "log_summary":
        case "sensor_reading":
        case "device_control":
            return "@cf/mistral/mistral-7b-instruct-v0.1"; // Best for text-based tasks

        default:
            return "@cf/mistral/mistral-7b-instruct-v0.1"; // Default fallback model
    }
}```

# File: ./types/itty-router-extras.d.ts

```typescript
declare module 'itty-router-extras' {
    export function error(status: number, body: any): Response;
    export function json(body: any): Response;
    export function status(code: number, init?: ResponseInit): Response;
    export function text(body: string, init?: ResponseInit): Response;
}
```

# File: ./types/analysis.ts

```typescript
import { PromptLibrary, PromptType } from '../types';

export interface CustomAnalysisRequest {
    prompt_template: {
        devices: string[];  // List of device IDs to analyze
        prompt: string;     // Custom analysis prompt
    }
}

export interface AnalysisResponse {
    success: boolean;
    request_id: string;
    results: {
        device_id: string;
        analysis: string;
        timestamp: string;
        snapshot_url?: string;
        state?: any;
    }[];
    error?: string;
    details?: any;
}

export interface DeviceAnalysisData {
    device_id: string;
    snapshot_base64?: string;
    snapshot_url?: string;
    state?: any;
}

export interface AnalysisContext {
    devices: DeviceAnalysisData[];
    prompt: string;
    prompt_type?: PromptType;
    category?: string;
    request_id: string;
}
```

# File: ./openapi-route.ts

```typescript
// Add this to your router configuration in index.ts

// OpenAPI specification endpoint
router.get('/openapi.json', async (request: Request, env: Env) => {
    const openApiService = new OpenAPIService();
    return openApiService.handleRequest(request);
});

// Optional: Add versioned endpoint for better maintainability
router.get('/api/v1/openapi.json', async (request: Request, env: Env) => {
    const openApiService = new OpenAPIService();
    return openApiService.handleRequest(request);
});```

# File: ./utils/camera.ts

```typescript
/**
 * Utility module for managing structured AI prompts based on the type of query.
 * This version organizes security-related analysis into structured queries.
 */
import { HassioApiService } from '../services/hassio.service';
import { CameraMetadata, CameraOrganization, CameraSnapshotResponse, Env, HomeAssistantDeviceState } from '../types';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { arrayBufferToBase64 } from '../utils/tools';

export const CAMERA_METADATA: Record<string, CameraMetadata> = {
  "camera.garage": {
    "camera_id": "camera.garage",
    "description": "Dual-purpose garage monitoring camera (1920x1080, 25fps) covering both interior hallway door and main street-level garage door (connects to driveway.camera coverage area). Critical monitoring points: vehicle presence/absence, garage door status, Wednesday trash removal confirmation. Camera provides essential security coverage for both home access points and vehicle storage area.",
    "location": "exterior",
    "floor": "garage",
    "group": "garage",
    "key_zones": ["garage", "driveway"],
    "use_case": ["vehicle presence detection", "door status monitoring", "security monitoring", "trash day confirmation", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
  },
  "camera.guest_bedroom": {
    "camera_id": "camera.guest_bedroom",
    "description": "Specialized monitoring camera focused on environmental concerns: water damage detection and rodent activity surveillance. Coverage includes sliding glass door to patio (overlaps with camera.patio coverage). Primary purpose is property protection through early detection of water intrusion or pest activity.",
    "location": "interior",
    "floor": "downstairs",
    "group": "bedroom",
    "key_zones": ["patio", "guest bedroom"],
    "use_case": ["water leak detection", "rodent activity monitoring", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.entry": {
    "camera_id": "camera.entry",
    "description": "High-resolution entrance camera (2688x1512, 30fps, enhanced bitrate) mounted above front door overlooking entry gate (complementing camera.doorbell coverage). Monitors vestibule area between entry gate and front door. Critical for package security monitoring once deliveries are inside locked gate. Forms monitoring triangle with camera.doorbell (front) and camera.lobby (interior door view) for comprehensive entrance security coverage.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["entry", "doorbell", "lobby"],
    "use_case": ["package security", "entrance monitoring", "motion detection", "person detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.driveway": {
    "camera_id": "camera.driveway",
    "description": "High-performance security camera (1920x1080, 50fps, high bitrate) monitoring driveway, sidewalk, and street. Works in conjunction with camera.doorbell for security monitoring. Critical features: vehicle license plate capture capability, suspect/vehicle description detail for security incidents. Important for monitoring: package theft attempts, delivery vehicle verification, contractor vehicle documentation, guest vehicle tracking. Enhanced frame rate supports clear motion capture of moving vehicles.",
    "location": "exterior",
    "floor": "front of house",
    "group": "driveway",
    "key_zones": ["driveway", "street", "sidewalk"],
    "use_case": ["license plate recognition", "vehicle identification", "security monitoring", "package theft prevention", "motion detection", "visitor detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.downstairs_living_room": {
    "camera_id": "camera.downstairs_living_room",
    "description": "High-resolution interior camera (2688x1512, 30fps) focused on sliding glass door patio access (corresponding with camera.patio exterior view). Primary monitoring point for dog indoor/outdoor transitions - main access point for pet potty breaks, play time, and outdoor investigation. Strategic positioning provides comprehensive coverage of main lower-level access point.",
    "location": "interior",
    "floor": "downstairs",
    "group": "living room",
    "key_zones": ["patio", "downstairs living room"],
    "use_case": ["pet monitoring", "door monitoring", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.grass_patch": {
    "camera_id": "camera.grass_patch",
    "description": "Exterior camera (1920x1080, 25fps) monitoring back property area. Primary monitoring zone for dog activities including potty breaks, play sessions, and investigative behavior. Important for wildlife monitoring - common sightings include mice, cats, and coyotes which may pose safety concerns for pets. Requires regular monitoring for potential wildlife threats.",
    "location": "exterior",
    "floor": "backyard",
    "group": "backyard",
    "key_zones": ["grass patch", "backyard"],
    "use_case": ["pet monitoring", "wildlife monitoring", "motion detection", "security monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.patio": {
    "camera_id": "camera.patio",
    "description": "Exterior camera overlooking patio area with view of lower level living room and guest bedroom sliding glass doors. Dogs primarily use right-side lower level living room sliding door for outdoor access. Notable positioning: forms monitoring pair with camera.downstairs_living_room (interior camera) - both cameras face opposite directions at same access point. Coverage area includes dog activity zones and potential wildlife areas.",
    "location": "exterior",
    "floor": "downstairs",
    "group": "patio",
    "key_zones": ["patio", "downstairs living room", "guest bedroom"],
    "use_case": ["pet monitoring", "security monitoring", "motion detection", "door monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.roof": {
    "camera_id": "camera.roof",
    "description": "Elevated exterior camera (2688x1512, 30fps, enhanced bitrate) mounted above primary bathroom skylight, aligned with camera.driveway direction. Primary purpose: monitoring flat roof drainage system, specifically roof drain and nearby vent. Critical for maintenance monitoring: alert if standing water persists beyond 48 hours, which risks roof leaks and warranty violations. Secondary monitoring: wildlife activity and human presence on adjacent or own roofing.",
    "location": "exterior",
    "floor": "roof",
    "group": "roof",
    "key_zones": ["roof", "driveway"],
    "use_case": ["roof drainage monitoring", "wildlife monitoring", "security monitoring", "water detection", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.lobby": {
    "camera_id": "camera.lobby",
    "description": "Interior camera (1920x1080, 30fps) monitoring the main lobby entrance area. Field of view includes three key areas: front door, garage hallway door, and upstairs staircase. Critical for monitoring resident and guest movement patterns. Notable behavior pattern: dogs typically wait by front door or garage hallway door when owners are away, providing indirect occupancy indication.",
    "location": "interior",
    "floor": "downstairs",
    "group": "lobby",
    "key_zones": ["lobby", "front door", "garage hallway"],
    "use_case": ["occupancy detection", "security monitoring", "motion detection", "pet monitoring"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.upstairs_living_room": {
    "camera_id": "camera.upstairs_living_room",
    "description": "Primary living space camera (2688x1512, 30fps) monitoring the upstairs area above garage. Field of view encompasses multiple zones: main TV/couch area, partial kitchen view behind couch, dining space at couch's end, stairwell from camera.lobby, and partial view of hallway leading to offices/bedrooms (sequence: Jason's office, primary bedroom, Justin's office, guest hall bath). Important to monitor dog behavior when owners are away.",
    "location": "interior",
    "floor": "upstairs",
    "group": "living room",
    "key_zones": ["upstairs living room", "lobby", "kitchen"],
    "use_case": ["pet monitoring", "occupancy detection", "security monitoring", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.doorbell": {
    "camera_id": "camera.doorbell",
    "description": "Primary front entrance monitoring camera (1600x1200) with motion detection. Positioned facing the street with camera.driveway 20ft to the left. Identifies delivery service by uniforms and vehicles: brown UPS uniforms/trucks, blue/purple FedEx uniforms with white/purple trucks, yellow/red DHL uniforms with yellow trucks, Amazon blue vests with branded vans, USPS blue uniforms with white trucks. Food delivery identified by branded bags. Critical for security and delivery monitoring.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["doorbell", "driveway", "street"],
    "use_case": ["delivery service identification", "person likely of ringing doorbell approaching", "security monitoring", "package theft", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
},
  "camera.package": {
    "camera_id": "camera.package",
    "description": "Specialized downward-facing package monitoring camera (1600x1200, 2fps) mounted under camera.doorbell. Identifies delivery type: Amazon (blue/black tape with smile logo), UPS (brown boxes), FedEx (white/purple packages), DHL (yellow packaging), USPS (white/blue packages). Food deliveries appear as branded paper/plastic bags or thermal bags. Package size and branding helps determine urgency.",
    "location": "exterior",
    "floor": "front of house",
    "group": "entrance",
    "key_zones": ["package", "doorbell"],
    "use_case": ["package identification", "delivery confirmation", "security monitoring", "package theft", "motion detection"],
    "state": "unknown", // Default state
    "attributes": {}, // Empty attributes object
    "snapshot_data": {
      "success": false,
      "snapshot_url": "",
      "snapshot_base64": ""
    }
  }
};

/**
 * Retrieves structured camera metadata, merging it with Home Assistant state data.
 */
export async function getCameraInfo(
    env: Env,
    apiService: HassioApiService,
    cameraId?: string
): Promise<CameraMetadata | CameraMetadata[]> {
    if (cameraId) {
        return await getSingleCameraInfo(env, apiService, cameraId);
    }

    return await getAllCamerasInfo(env, apiService);
}

/**
 * Fetches metadata for a single camera, merging Home Assistant state data.
 */
async function getSingleCameraInfo(env: Env, apiService: HassioApiService, cameraId: string): Promise<CameraMetadata> {
    try {
        const response = await apiService.getEntityState(env, cameraId);
        if (!response.ok) {
            throw new Error(`Failed to fetch camera state: ${response.status}`);
        }

        const cameraState = await response.json() as HomeAssistantDeviceState;
        const metadata = CAMERA_METADATA[cameraId] ?? createDefaultMetadata(cameraId);

        return mergeMetadataWithState(metadata, cameraState);
    } catch (error) {
        console.error(`Error retrieving metadata for camera ${cameraId}:`, error);
        return createDefaultMetadata(cameraId, "Failed to retrieve metadata.");
    }
}

/**
 * Fetches metadata for all cameras with state data and snapshots.
 */
async function getAllCamerasInfo(env: Env, apiService: HassioApiService): Promise<CameraMetadata[]> {
    const cameraEntries = Object.entries(CAMERA_METADATA) as [string, CameraMetadata][];

    const cameraPromises = cameraEntries.map(async ([cameraId, metadata]) => {
        try {
            const response = await apiService.getEntityState(env, cameraId);
            if (!response.ok) {
                throw new Error(`Failed to fetch camera state: ${response.status}`);
            }

            const cameraState = await response.json() as HomeAssistantDeviceState;

            let snapshot_success = false;
            let snapshot_url = `${env.HASSIO_URL}/api/camera_proxy/${cameraId}`;
            let snapshot_base64 = '';

            try {
                const snapshotResponse = await getBase64Snapshot(snapshot_url, cameraId);
                if (snapshotResponse) {
                    snapshot_success = true;
                    snapshot_base64 = snapshotResponse;
                }
            } catch (error) {
                console.error(`Failed to fetch snapshot for ${cameraId}:`, error);
            }

            const snapshot_data: CameraSnapshotResponse = {
                success: snapshot_success,
                snapshot_url,
                snapshot_base64
            };

            return {
                ...metadata,
                camera_id: cameraState.entity_id,
                state: cameraState.state,
                attributes: {
                    ...cameraState.attributes,
                    description: metadata.description,
                    location: metadata.location,
                    floor: metadata.floor,
                    group: metadata.group,
                    key_zones: metadata.key_zones,
                    use_case: metadata.use_case,
                    last_reported: new Date().toISOString()
                },
                snapshot_data
            };
        } catch (error) {
            console.error(`Error retrieving metadata for camera ${cameraId}:`, error);
            return createDefaultMetadata(cameraId);
        }
    });

    return await Promise.all(cameraPromises);
}

/**
 * Merges Home Assistant state data into camera metadata.
 */
function mergeMetadataWithState(metadata: CameraMetadata, cameraState: HomeAssistantDeviceState): CameraMetadata {
    return {
        ...metadata,
        camera_id: cameraState.entity_id,
        state: cameraState.state,
        attributes: {
            ...cameraState.attributes,
            description: metadata.description,
            location: metadata.location,
            floor: metadata.floor,
            group: metadata.group,
            key_zones: metadata.key_zones,
            use_case: metadata.use_case,
            last_reported: new Date().toISOString()
        }
    };
}

/**
 * Creates a default camera metadata entry.
 */
function createDefaultMetadata(cameraId: string, description: string = "Unknown camera. No metadata found."): CameraMetadata {
    return {
        camera_id: cameraId,
        description,
        state: "unknown",
        location: "exterior",
        floor: "front of house",
        group: "unknown",
        key_zones: [],
        use_case: [],
        attributes: {
            description,
            location: "exterior",
            floor: "front of house",
            group: "unknown",
            key_zones: [],
            use_case: [],
            last_reported: new Date().toISOString()
        },
        snapshot_data: {
            success: false,
            snapshot_url: "",
            snapshot_base64: ""
        }
    };
}

/**
 * Retrieves all cameras belonging to a key zone.
 */
export function getCamerasByZone(zone: string): CameraMetadata[] {
    return (Object.entries(CAMERA_METADATA) as [string, CameraMetadata][])
        .filter(([_, data]) => data.key_zones.includes(zone))
        .map(([id, data]) => ({
            ...data,
            camera_id: id
        }));
}

/**
 * Retrieves cameras based on a given use case.
 */
export async function getCamerasByUseCase(
    env: Env,
    apiService: HassioApiService,
    useCase: string
): Promise<CameraMetadata[]> {
    const allCameras = await getAllCamerasInfo(env, apiService);
    return allCameras.filter(camera => camera.use_case.includes(useCase));
}

/**
 * Retrieves all available use cases.
 */
export function getAvailableUseCases(): string[] {
    const useCases = new Set<string>();
    (Object.values(CAMERA_METADATA) as CameraMetadata[]).forEach(camera => {
        camera.use_case.forEach(useCase => useCases.add(useCase));
    });
    return Array.from(useCases);
}

/**
 * Builds a structured organization of cameras.
 */
export function buildCameraOrganization(env?: Env): CameraOrganization {
    const organization: CameraOrganization = {
        use_case: {},
        location: {},
        floor: {},
        group: {}
    };

    (Object.entries(CAMERA_METADATA) as [string, CameraMetadata][]).forEach(([cameraId, metadata]) => {
        // Organize by use_case
        metadata.use_case.forEach(useCase => {
            if (!organization.use_case[useCase]) {
                organization.use_case[useCase] = [];
            }
            organization.use_case[useCase].push(cameraId);
        });

        // Organize by location
        if (metadata.location) {
            if (!organization.location[metadata.location]) {
                organization.location[metadata.location] = [];
            }
            organization.location[metadata.location].push(cameraId);
        }

        // Organize by floor
        if (metadata.floor) {
            if (!organization.floor[metadata.floor]) {
                organization.floor[metadata.floor] = [];
            }
            organization.floor[metadata.floor].push(cameraId);
        }

        // Organize by group
        if (metadata.group) {
            if (!organization.group[metadata.group]) {
                organization.group[metadata.group] = [];
            }
            organization.group[metadata.group].push(cameraId);
        }
    });

    return organization;
}

/**
 * Retrieves cameras based on a specific monitoring group.
 */
export async function getCamerasByGroup(
    env: Env,
    apiService: HassioApiService,
    group: string
): Promise<CameraMetadata[]> {
    const allCameras = await getAllCamerasInfo(env, apiService);
    return allCameras.filter(camera => camera.group === group);
}

/**
 * Fetches a snapshot and converts it to Base64.
 */
export async function getBase64Snapshot(snapshotUrl: string, cameraId: string): Promise<string> {
    try {
        const response = await fetch(snapshotUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch snapshot: ${response.status} - ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return arrayBufferToBase64(arrayBuffer);
    } catch (error) {
        console.error(`Error getting base64 snapshot for camera ${cameraId}:`, error);
        throw error;
    }
}
```

# File: ./utils/prompts.ts

```typescript
import { PromptCategory, PromptLibrary, PromptType } from '../types';

/**
 * Structured AI Prompts categorized by type.
 */
export const PROMPT_LIBRARY: PromptLibrary = {
    general_status: {
        devices: [
            'camera.doorbell',
            'camera.driveway',
            'camera.entry',
            'camera.package',
            'camera.garage',
            'camera.upstairs_living_room',
            'camera.downstairs_living_room',
            'camera.patio',
            'camera.roof',
            'camera.grass_patch',
            'camera.lobby'
        ],
        description: "Provide a general status update for any camera in the system",
        prompt: `Analyze the camera feed and provide a concise status update based on the camera's location:

            Entry Points (doorbell, driveway, entry):
            - Is anyone approaching or present?
            - Are there any vehicles moving or parked?
            - Are there any packages visible?

            Indoor Areas (upstairs/downstairs living room, lobby):
            - Are any people or pets present?
            - What is their general activity?

            Outdoor Areas (patio, grass patch):
            - Are any people or pets present?
            - Is there any notable activity?
            - For patio: Is the door open/closed?

            Specialized Areas:
            - Garage: Vehicle presence? Door open/closed?
            - Package Area: Any packages present? Brief description?
            - Roof: Any visible issues or water pooling?

            Keep responses brief and focused. If nothing significant is happening, report 'nothing meaningful'.`
    },
    security_analysis: {
        entry_points: {
            devices: ['camera.doorbell', 'camera.driveway', 'camera.entry'],
            description: "Detect if anyone is at the entry points (doorbell, driveway, or entry cameras).",
            prompt: "Analyze camera.doorbell, camera.entry, and camera.driveway. Identify if someone is present, describe their appearance, and determine if they are a delivery person."
        },
        package_detection: {
            devices: ['camera.package'],
            description: "Detect packages at the doorstep.",
            prompt: "Analyze camera.package. Identify if a package is present and describe its appearance (Amazon-branded, plain box, food delivery, etc.)."
        },
        vehicle_monitoring: {
            devices: ['camera.driveway', 'camera.garage'],
            description: "Monitor vehicle presence in the driveway and garage.",
            prompt: `Analyze camera.driveway and camera.garage.
                - Detect if a car is parked or blocking the driveway.
                - Extract vehicle details: make, model, color, and license plate.
                - Detect if a car is inside the garage and if the garage door is open or closed.`
        },
        indoor_monitoring: {
            devices: ['camera.upstairs_living_room', 'camera.downstairs_living_room', 'camera.patio'],
            description: "Monitor indoor activity (people, pets, and cleaning robots).",
            prompt: `Analyze indoor cameras: camera.upstairs_living_room, camera.downstairs_living_room, camera.patio.
                - Detect and describe any people present.
                - Identify if any dogs are present (French Bulldog, Corgi, etc.).
                - Describe dog activity (playing, sleeping, barking).
                - Identify cleaning robots and determine if they are operating normally or stuck.`
        },
        roof_monitoring: {
            devices: ['camera.roof'],
            description: "Check the roof for water pooling and damage.",
            prompt: `Analyze camera.roof.
                - Detect any standing water.
                - Estimate the percentage of the roof affected.
                - Identify the location (puddles near drains, along roof edges, etc.).`
        },
        door_status: {
            devices: ['sensor.front_door_lock', 'sensor.back_door_lock', 'sensor.garage_entry_lock'],
            description: "Check the status of all entry doors in the home.",
            prompt: `Perform a security check on all entry doors using Home Assistant door lock sensors.
                - **Verify door lock status** for all exterior doors [excluding "Betsy" doors entirely]
                - If any door is **unlocked**, list the specific unlocked doors.
                - If all doors are **securely locked**, confirm security status.

                **🔄 Auto-Locking Logic:**
                - **Daytime (Sun is Up ☀️):** Auto-lock any unlocked door that has been open for **15+ minutes**.
                - **Nighttime (After Sunset 🌙):** Auto-lock any unlocked door **immediately (0+ minutes open).**
                - **If a door was auto-locked**, notify the user with:
                    🔒 "The [front/back/garage] door was left unlocked for X minutes. Auto-locking for security."
                - **If auto-locking failed**, notify the user with:
                    ⚠️ "Warning! Attempted to lock the [front/back/garage] door, but it failed. Please check manually."

                **🚨 Alert & Notification Triggers:**
                - If the system is in **'away' mode** and **any door is unlocked**, send a **high-priority security alert**.
                - If a door is **auto-locked**, log the action and notify the user.
                - If an auto-lock attempt **fails**, notify the user to take action.

                **Additional Considerations:**
                - If door sensors indicate the **door is open**, prevent auto-locking and notify the user.
                - Log all **auto-lock events & failures** in Home Assistant for security auditing.`
        },
        garage_monitoring: {
            devices: ['camera.garage', 'sensor.garage_door', 'sensor.tesla_wall_connector_status', 'sensor.betsy_charging', 'device_tracker.betsy_location', 'binary_sensor.betsy_charger', 'device_tracker.betsy_location_tracker', 'sensor.betsy_data_last_update_time', 'button.betsy_wake_up', 'button.betsy_wake'],
            description: "Monitor garage security and car presence using both cameras and Tesla API sensors.",
            prompt: `Perform a comprehensive garage and driveway security analysis using:
                - **Camera Data:** camera.garage (inside garage), camera.driveway (driveway view)
                - **Tesla API Sensors:** Real-time vehicle location, charging status, and door state.

                **Vehicle Details:**
                - The homeowners own a **2019 Black Tesla Model 3** nicknamed **"Betsy"**.
                - Prioritize identifying "Betsy" using both **camera images** and **Tesla API vehicle location data**.

                **Garage Monitoring (4 Conditions):**
                - 🚨  "Betsy" is **inside the garage** & **garage door is open** → Set input_boolean.garage_door_open_with_car.
                - ✅ "Betsy" is **inside the garage** & **garage door is closed** → Set input_boolean.garage_door_closed_with_car.
                - 🚨  "Betsy" is **NOT in the garage** & **garage door is open** → Set input_boolean.garage_door_open_without_car.
                - ✅ "Betsy" is **NOT in the garage** & **garage door is closed** → Set input_boolean.garage_door_closed_without_car.

                **Driveway Monitoring (4 Conditions):**
                - 🚨  "Betsy" is **in the driveway** & **garage door is open** → Set input_boolean.garage_door_open_car_parked_driveway.
                - ✅ "Betsy" is **in the driveway** & **garage door is closed** → Set input_boolean.garage_door_closed_car_parked_driveway.
                - 🚨  "Betsy" is **NOT in the driveway** & **garage door is open** → Set input_boolean.garage_door_open_driveway_clear.
                - ✅ "Betsy" is **NOT in the driveway** & **garage door is closed** → Set input_boolean.garage_door_closed_driveway_clear.

                **Real-time Alert Triggers:**
                - 🚨 If "Betsy" **is parked outside (driveway or street)** but **garage door is open**, notify user.
                - 🚨 If "Betsy" **is actively charging** using the **home charger**, ensure **garage door is securely closed**.
                - 🚨 If "Betsy" **is plugged into the charger but not charging**, notify user to check for charging issues.
                - 🚨 If **any vehicle is parked in the garage**, but the **garage door remains open for 5+ minutes**, send a reminder.
                - 🚨 If **no vehicle is parked in the garage**, and the **garage door remains open for 30+ seconds**, notify user & auto-close.

                **Additional Considerations:**
                - 🏠 Home Assistant should **automatically close the garage door** if it's left open and no car is detected.
                - 🛠️ If Tesla API data conflicts with camera data, prioritize Tesla GPS location for accuracy.
                - 📊 Store logs of garage door actions & vehicle presence for **security review**.`
        },
        automated_security_sweep: []
    },
    pet_monitoring: {
        dog_monitoring: {
            devices: [
                "camera.upstairs_living_room",
                "camera.lobby",
                "camera.downstairs_living_room",
                "camera.patio",
                "camera.grass_patch"
            ],
            description: "Monitors the activity and behavior of two dogs, Louis (Brindle French Bulldog) and Ollie (Tri-Color Corgi), across various rooms to track their movement, play, potty habits, and potential health concerns.",
            prompt: `Analyze the security cameras for dog activity. Focus on the two dogs in the home:

                - **Louis (Brindle French Bulldog)**
                - **Ollie (Tri-Color Corgi)**

                📍 **Room-Specific Monitoring:**
                1️⃣ **Upstairs Living Room (camera.upstairs_living_room)**
                    - Are the dogs eating, laying on the couch, walking around, or sitting by the stairs?
                2️⃣ **Lobby (camera.lobby)**
                    - Are the dogs waiting by the door?
                    - Are they showing signs of needing to go outside?
                3️⃣ **Downstairs Living Room (camera.downstairs_living_room)**
                    - Are the dogs walking around?
                    - Are the dogs outside waiting by the glass door to come in?
                4️⃣ **Patio & Grass Patch (camera.patio & camera.grass_patch)**
                    - Are the dogs outside?
                    - If yes, are they using the potty?
                    - Which dog(s) used the potty and where?
                    - Are they playing? If so, describe their play behavior.

                🚨 **Behavior Alerts (Any Room)**
                - Are either dog(s) **using the bathroom inside**? Which dog(s)?
                - 🚨 Is there **evidence of peeing, pooping, or throwing up**? Which dog(s)?
                - Is either dog **licking excessively**? If so, which dog?
                - 🚨 **Any concerning health behaviors?** If yes, describe the issue.

                📌 **Important Instructions:**
                - **Describe dog activity clearly** based on room location.
                - **If a concerning behavior is detected, alert the user**.
                - **Provide a summary of each dog's actions** with timestamps where possible.`
        }
    },
    robot_monitoring: {},
    data_analysis: {}
};

// Type guard to check if an object is a PromptCategory
function isPromptCategory(obj: any): obj is PromptCategory {
    return obj &&
           typeof obj === 'object' &&
           'devices' in obj &&
           'description' in obj &&
           'prompt' in obj &&
           Array.isArray(obj.devices);
}

/**
 * Dynamically build category and pattern maps for prompt lookup across all registered prompt types.
 */
const categoryMap: Record<string, { type: PromptType; category: keyof PromptLibrary[PromptType] }> = {};
const patternMap: [RegExp, { type: PromptType; category: keyof PromptLibrary[PromptType] }][] = [];

// Iterate through all registered prompt categories
for (const [promptType, categories] of Object.entries(PROMPT_LIBRARY) as [PromptType, PromptLibrary[PromptType]][]) {
    for (const [category, promptData] of Object.entries(categories)) {
        if (isPromptCategory(promptData)) {
            // Add exact device mappings
            for (const device of promptData.devices) {
                categoryMap[device] = { type: promptType as PromptType, category: category as keyof PromptLibrary[PromptType] };
            }

            // Add pattern-based mappings
            const devicePatterns = promptData.devices.map(device => device.replace(/\./g, '\\.'));
            const regexPattern = new RegExp(`^(${devicePatterns.join('|')})$`);
            patternMap.push([
                regexPattern,
                { type: promptType as PromptType, category: category as keyof PromptLibrary[PromptType] }
            ]);
        }
    }
}

/**
 * Determines the appropriate prompt categories based on a given camera or sensor ID.
 * @param entityId - The entity ID of the camera or sensor
 * @param categoryType - Optional filter for a specific prompt type
 * @returns An array of matching prompt categories
 */
export function getPromptCategoryForCamera<T extends keyof PromptLibrary>(
    entityId: string,
    categoryType?: T
): { type: T; category: keyof PromptLibrary[T] }[] {
    let matches: { type: keyof PromptLibrary; category: keyof PromptLibrary[keyof PromptLibrary] }[] = [];

    // Exact match lookup in categoryMap
    if (categoryMap[entityId]) {
        matches.push(categoryMap[entityId]);
    }

    // Pattern-based lookup using regex matching
    matches.push(...patternMap
        .filter(([regex]) => regex.test(entityId))
        .map(([, match]) => match)
    );

    // If categoryType is specified, filter results
    if (categoryType) {
        matches = matches.filter(match => match.type === categoryType);
    }

    // Ensure return type matches `T`
    return matches.map(match => ({
        type: match.type as T,
        category: match.category as keyof PromptLibrary[T]
    }));
}

// Populate `automated_security_sweep` dynamically with proper type checking
PROMPT_LIBRARY.security_analysis.automated_security_sweep = Object.entries(PROMPT_LIBRARY.security_analysis)
    .filter(([key, value]) => key !== 'automated_security_sweep' && isPromptCategory(value))
    .map(([, value]) => value as PromptCategory);

/**
 * Retrieves structured prompts for a given category.
 * @param type - The type of prompt category
 * @param category - The subcategory within the type
 * @returns A structured prompt or null if not found
 */
export function getPrompt<T extends PromptType>(
    type: T,
    category: keyof PromptLibrary[T]
): PromptCategory | PromptCategory[] | null {
    if (!PROMPT_LIBRARY[type]) {
        return null;
    }

    const categoryData = PROMPT_LIBRARY[type][category];

    if (!categoryData) {
        return null;
    }

    // Handle array case (like automated_security_sweep)
    if (Array.isArray(categoryData)) {
        return categoryData.filter(isPromptCategory);
    }

    // Handle single prompt case
    if (isPromptCategory(categoryData)) {
        return categoryData;
    }

    return null;
}

// Export the type guard for external use
export { isPromptCategory };
```

# File: ./utils/response.ts

```typescript
/**
 * @fileoverview Response utility functions for standardizing API responses
 */

/**
 * Creates a JSON response with proper headers
 * @param data - Data to be JSON stringified
 * @param options - Optional Response initialization options
 * @returns Response object with JSON headers
 */
export function json(data: any, options: ResponseInit = {}): Response {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    return new Response(JSON.stringify(data), {
        ...options,
        headers,
    });
}

/**
 * Creates a standardized error response
 * @param status - HTTP status code
 * @param data - Error data (string or object)
 * @returns Response object with error details
 */
export function error(status: number, data: string | Record<string, any>): Response {
    return json(
        {
            success: false,
            error: typeof data === 'string' ? data : data.error || 'Unknown error',
            details: typeof data === 'string' ? undefined : data,
        },
        { status }
    );
}

/**
 * Creates a success response with standardized format
 * @param data - Success response data
 * @param options - Optional Response initialization options
 * @returns Response object with success details
 */
export function success(data: any, options: ResponseInit = {}): Response {
    return json({
        success: true,
        data,
    }, options);
}

/**
 * Creates a redirect response
 * @param url - URL to redirect to
 * @param status - HTTP status code (default: 302)
 * @returns Response object with redirect
 */
export function redirect(url: string, status: number = 302): Response {
    return new Response(null, {
        status,
        headers: {
            Location: url
        }
    });
}

/**
 * Creates a not found response
 * @param message - Optional custom message
 * @returns Response object for 404
 */
export function notFound(message: string = 'Not Found'): Response {
    return error(404, message);
}

/**
 * Creates an unauthorized response
 * @param message - Optional custom message
 * @returns Response object for 401
 */
export function unauthorized(message: string = 'Unauthorized'): Response {
    return error(401, message);
}

/**
 * Creates a forbidden response
 * @param message - Optional custom message
 * @returns Response object for 403
 */
export function forbidden(message: string = 'Forbidden'): Response {
    return error(403, message);
}

/**
 * Creates a bad request response
 * @param message - Optional custom message or error details
 * @returns Response object for 400
 */
export function badRequest(message: string | Record<string, any> = 'Bad Request'): Response {
    return error(400, message);
}

/**
 * Creates a server error response
 * @param message - Optional custom message or error details
 * @returns Response object for 500
 */
export function serverError(message: string | Record<string, any> = 'Internal Server Error'): Response {
    return error(500, message);
}
```

# File: ./utils/database.ts

```typescript
/**
 * @fileoverview Database utilities for handling D1 database operations
 * This module provides structured database access and logging functionality
 */

import { D1Database, D1Result } from '@cloudflare/workers-types';

/**
 * Ensures the request logging task exists in the database
 * @param db - D1 database instance
 * @returns ID of the logging task
 */
export async function ensureRequestLoggingTask(db: D1Database): Promise<number> {
    const { results } = await db.prepare(`
        SELECT id FROM automation_tasks
        WHERE title = 'Request Logger'
        LIMIT 1
    `).all<{ id: number }>();

    if (results[0]?.id) {
        return results[0].id;
    }

    await db.prepare(`
        INSERT INTO automation_tasks (
            title, description, type, trigger_spec, instructions, is_active, priority
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
        'Request Logger',
        'System task for logging incoming requests',
        'event',
        'request',
        'Log incoming requests to the system',
        true,
        1
    ).run();

    const { results: newResults } = await db.prepare(`
        SELECT id FROM automation_tasks
        WHERE title = 'Request Logger'
        LIMIT 1
    `).all<{ id: number }>();

    return newResults[0]?.id ?? -1;
}

/**
 * Logs an incoming request to the database
 * @param db - D1 database instance
 * @param request - HTTP request to log
 */
export async function logRequest(db: D1Database, request: Request): Promise<void> {
    const url = new URL(request.url);
    const taskId = await ensureRequestLoggingTask(db);

    const headerEntries: [string, string][] = [];
    request.headers.forEach((value, key) => {
        headerEntries.push([key, value]);
    });

    await db.prepare(`
        INSERT INTO automation_logs (
            task_id, execution_id, type, content, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
        taskId,
        crypto.randomUUID(),
        'start',
        `${request.method} ${url.pathname}`,
        JSON.stringify({
            url: request.url,
            headers: Object.fromEntries(headerEntries)
        })
    ).run();
}

/**
 * Queries chat history with optional search and pagination
 * @param db - D1 database instance
 * @param searchQuery - Optional search term
 * @param limit - Maximum number of results to return
 */
export async function queryChatHistory(
    db: D1Database,
    searchQuery?: string,
    limit: number = 100
): Promise<Response> {
    try {
        let query = `
            SELECT c.*, al.content as request_log
            FROM conversations c
            LEFT JOIN automation_logs al ON c.session_id = al.execution_id
            WHERE al.type = 'start'
        `;
        const params: any[] = [];

        if (searchQuery) {
            query += ` AND (c.messages LIKE ? OR al.content LIKE ?)`;
            params.push(`%${searchQuery}%`, `%${searchQuery}%`);
        }

        query += ` ORDER BY c.created_at DESC LIMIT ?`;
        params.push(limit);

        const { results } = await db.prepare(query).bind(...params).all();
        return new Response(JSON.stringify(results), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(JSON.stringify({
            error: 'Error querying chat history',
            details: errorMessage
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Creates necessary database tables if they don't exist
 * @param db - D1 database instance
 */
export async function initializeDatabase(db: D1Database): Promise<void> {
    const migrations = [
        `CREATE TABLE IF NOT EXISTS automation_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            type TEXT NOT NULL,
            trigger_spec TEXT,
            instructions TEXT,
            is_active BOOLEAN DEFAULT true,
            priority INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS automation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            execution_id TEXT NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (task_id) REFERENCES automation_tasks(id)
        )`,
        `CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            messages TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    ];

    for (const migration of migrations) {
        await db.prepare(migration).run();
    }
}
```

# File: ./utils/tools.ts

```typescript
/**
 * Converts an ArrayBuffer to a Base64 string (Cloudflare Workers-compatible).
 * Uses a TextDecoder approach for better performance in Cloudflare.
 * @param arrayBuffer - The ArrayBuffer to encode.
 * @returns A Base64-encoded string.
 */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert binary data to a string
    const binaryString = String.fromCharCode(...uint8Array);

    // Encode to Base64
    return btoa(binaryString);
}```

# File: ./utils/homeassistant-proxy.ts

```typescript
import { Env } from '../types';

export async function proxyToHomeAssistant(request: Request, env: Env): Promise<Response> {
    try {
        // Convert headers to a plain object for logging
        const headerObj: Record<string, string> = {};
        request.headers.forEach((value, key) => {
            headerObj[key] = value;
        });

        console.log('Proxying request:', {
            original_url: request.url,
            method: request.method,
            headers: headerObj
        });

        // Parse the original URL to get the path
        const originalUrl = new URL(request.url);
        const targetUrl = new URL(originalUrl.pathname + originalUrl.search, env.HASSIO_URL);

        // Set up headers
        const headers = new Headers(request.headers);
        headers.delete('host');  // Remove host header to prevent conflicts
        headers.set('Authorization', `Bearer ${env.HASSIO_TOKEN}`);

        // Set content-type for requests with bodies
        if (!['GET', 'HEAD'].includes(request.method) && !headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }

        // Create the proxy request
        const proxyRequest = new Request(targetUrl.toString(), {
            method: request.method,
            headers: headers,
            body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        });

        console.log('Sending proxy request to:', targetUrl.toString());

        // Validate URL before making request
        if (!targetUrl.toString().startsWith(env.HASSIO_URL)) {
            throw new Error('Invalid Home Assistant URL');
        }

        // Make the request with a timeout
        const timeoutPromise = new Promise<Response>((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 30000); // 30 second timeout
        });

        const fetchPromise = fetch(proxyRequest).catch(error => {
            console.error('Fetch error:', error);
            throw new Error(`Failed to connect to Home Assistant: ${error.message}`);
        });

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        // Convert response headers to a plain object for logging
        const responseHeaderObj: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaderObj[key] = value;
        });

        console.log('Received response:', {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaderObj
        });

        // If we get here, we have a valid response
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    } catch (error) {
        console.error('Proxy error:', error);

        // Return a properly structured error response
        return new Response(JSON.stringify({
            success: false,
            error: 'Failed to proxy request to Home Assistant',
            details: error instanceof Error ? error.message : String(error)
        }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            }
        });
    }
}
```

# File: ./utils/model-selector.ts

```typescript
export function selectAIModel(taskType: string): string {
    switch (taskType) {
        case "image_analysis":
        case "camera_security":
        case "object_detection":
        case "garage_monitoring":
        case "roof_inspection":
            return "@cf/meta/llama-3.2-11b-vision-instruct"; // Best for images

        case "text_query":
        case "home_status":
        case "log_summary":
        case "sensor_reading":
        case "device_control":
            return "@cf/mistral/mistral-7b-instruct-v0.1"; // Best for text-based tasks

        default:
            return "@cf/mistral/mistral-7b-instruct-v0.1"; // Default fallback model
    }
}```

# File: ./types.ts

```typescript
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export interface Env {
    CHAT_MEMORY: KVNamespace;
    DB: D1Database;
    AI: Ai;
    HASSIO_URL: string;
    HASSIO_TOKEN: string;
    CF_BASE_URL: string;
    CF_API_KEY: string;
    call: (service: string, data?: any) => Promise<void>;
}

export interface CameraDevice {
    entity_id: string;
    state: string;
    attributes: any;
    friendly_name: string;
    motion_detection: boolean;
    stream_type: string;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    channel_id: string;
    attribution: string;
    supported_features: number;
    last_changed: string;
    last_updated: string;
    last_reported: string;
    snapshot_url: string;
    stream_url: string;
    snapshot_base64: string;
    snapshot_data: CameraSnapshotResponse;
    prompt_class: PromptType;
    analysis?: CameraAnalysisResult;
}

export interface CameraAnalysisOptions {
    target_width: number;
    max_frames: number;
    detail: 'High' | 'Medium' | 'Low';
    temperature: number;
    expose_images: boolean;
    model: string;
}

export interface CameraAnalysisResult {
    camera_id: string;
    description: string;
    snapshot_url: string;
    stream_url: string;
    snapshot_base64: string;
    timestamp: string;
}

type SecurityStatus = 'pending' | 'secure' | 'warning' | 'alert';

interface SecurityCategoryResult {
    status: SecurityStatus;
    details: string;
    alerts?: string[];
}

export interface SecurityPatrolResult {
    timestamp: string;
    entry_points: SecurityCategoryResult;
    package_detection: SecurityCategoryResult;
    vehicle_monitoring: SecurityCategoryResult;
    indoor_monitoring: SecurityCategoryResult;
    roof_monitoring: SecurityCategoryResult;
    door_status: SecurityCategoryResult;
    garage_monitoring: SecurityCategoryResult;
    overall_security_status: SecurityStatus;
    alerts: string[];
}

export interface SecurityResult {
    car_parked?: boolean;
    garage_door_open?: boolean;
    vehicle_details?: {
        make?: string;
        model?: string;
        color?: string;
        license_plate?: string;
    };
    person_at_door?: boolean;
    is_delivery_person?: boolean;
    person_description?: string;
    delivery_truck_nearby?: boolean;
    package_present?: boolean;
    package_details?: {
        type?: string;
        appearance?: string;
    };
    people_present?: boolean;
    dogs_present?: boolean;
    dog_details?: {
        breed: string[];
        activity: string;
    };
    robot_status?: {
        operating: boolean;
        stuck: boolean;
        location?: string;
    };
    roof_water_present?: boolean;
    roof_water_details?: {
        percentage_affected: number;
        location: string;
    };
    suspicious_activity?: boolean;
    suspicious_activity_details?: string;
    camera_check_required?: boolean;
    camera_id?: string;
}

export interface WebSocketClient {
    socket: WebSocket;
    subscriptions: Set<string>;
    lastPing: number;
}

export interface HomeAssistantProxy {
    proxyToHomeAssistant: (request: Request, env: Env) => Promise<Response>;
}

export interface HomeAssistantDeviceState {
    entity_id: string;
    state: string;
    attributes?: any;
    last_changed?: string;
    last_updated?: string;
    last_reported?: string;
}

export interface CameraSnapshotResponse {
    success: boolean;
    snapshot_url: string;
    snapshot_base64: string;
    request_id?: string;
}

export interface DeviceListResponse {
    success: boolean;
    devices: HomeAssistantDeviceState[];
    count: number;
    request_id?: string;
}

export interface ErrorResponse {
    success: false;
    error: string;
    details: string;
    request_id?: string;
}

export interface AiMessageContent {
    type: 'text' | 'image';
    data: string;
}

export interface AiMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | AiMessageContent[];
}

export interface AiResponse {
    response: string;
}

export type OpenAPISchema = {
    type: string;
    properties?: Record<string, any>;
    items?: OpenAPISchema;
    enum?: string[];
    required?: string[];
} | {
    $ref: string;
};

export interface OpenAPIPath {
    summary: string;
    description?: string;
    parameters?: Array<{
        name: string;
        in: string;
        required: boolean;
        schema: OpenAPISchema;
        description?: string;
    }>;
    requestBody?: {
        content: {
            'application/json': {
                schema: OpenAPISchema;
            };
        };
    };
    responses: {
        [key: string]: {
            description: string;
            content?: {
                'application/json': {
                    schema: OpenAPISchema;
                };
            };
        };
    };
}

export interface OpenAPISpec {
    openapi: string;
    info: {
        title: string;
        version: string;
        description: string;
    };
    servers: Array<{
        url: string;
        description: string;
    }>;
    security?: Array<Record<string, string[]>>;
    components: {
        securitySchemes: {
            ApiKeyAuth: {
                type: string;
                in: string;
                name: string;
                description: string;
            };
            BearerAuth: {
                type: string;
                scheme: string;
                bearerFormat: string;
                description: string;
            };
        };
        schemas?: Record<string, OpenAPISchema>;
    };
    paths: Record<string, Record<string, OpenAPIPath>>;
}

export interface Prompt {
    description: string;
    query: string;
}

export interface PromptCategory {
    devices: string[];
    description: string;
    prompt: string;
}

export interface PromptLibrary {
    general_status: PromptCategory;
    security_analysis: {
        entry_points: PromptCategory;
        package_detection: PromptCategory;
        vehicle_monitoring: PromptCategory;
        indoor_monitoring: PromptCategory;
        roof_monitoring: PromptCategory;
        door_status: PromptCategory;
        garage_monitoring: PromptCategory;
        automated_security_sweep: PromptCategory[];
    };
    pet_monitoring: {
        dog_monitoring: PromptCategory;
    };
    robot_monitoring: Record<string, never>;
    data_analysis: Record<string, never>;
}

export type PromptType = keyof PromptLibrary;

export interface CameraMetadata {
    camera_id: string;
    state: string;
    description: string;
    location: 'interior' | 'exterior' | 'unknown';
    floor: 'upstairs' | 'downstairs' | 'roof' | 'backyard' | 'front of house' | 'garage' | 'unknown';
    group: string;
    key_zones: string[];
    use_case: string[];
    attributes: object;
    snapshot_data: CameraSnapshotResponse;
}

export interface CameraZoneGroup {
    zone: string;
    cameras: { camera_id: string; description: string }[];
}

export type CameraInfoResponse = CameraMetadata | CameraMetadata[];

export type CameraZoneResponse = { camera_id: string; description: string }[];

export interface CameraOrganization {
    use_case: Record<string, string[]>;
    location: Record<string, string[]>;
    floor: Record<string, string[]>;
    group: Record<string, string[]>;
}

export interface EntityStateUpdate {
    state: string;
    attributes?: Record<string, any>;
}

export interface IntentData {
    name: string;
    slots?: Record<string, any>;
    parameters?: Record<string, any>;
}

export interface ServiceCallData {
    domain: string;
    service: string;
    data?: Record<string, any>;
}

export interface EventData {
    event_type: string;
    data?: Record<string, any>;
}```

# File: ./index.ts

```typescript
/**
 * @fileoverview Main worker entry point for Home Assistant API
 * Handles routing, authentication, and integration of all components
 */

import { Router } from 'itty-router';
import { AnalysisHandler } from './handlers/analysis';
import { DeviceHandler } from './handlers/devices';
import { EnhancedStatesHandler } from './handlers/enhanced-states';
import { ApiDocumentation } from './services/documentation.service';
import { HassioApiService } from './services/hassio.service';
import { OpenAPIService } from './services/openapi.service';
import { SecurityWorker } from './services/security';
import { CameraSnapshotResponse, Env, PromptType } from './types';
import { getAvailableUseCases, buildCameraOrganization } from './utils/camera';
import { logRequest, queryChatHistory } from './utils/database';
import { proxyToHomeAssistant } from './utils/homeassistant-proxy';
import { error, json } from './utils/response';

// Create router
const router = Router();

/**
 * Authentication middleware that returns void if authenticated
 * or throws an error if not
 */
async function authenticate(request: Request, env: Env): Promise<void> {
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.CF_API_KEY) {
        throw new Error('Unauthorized');
    }
}

// Add authentication to routes that need it
router.all('/api/*', authenticate);
router.all('/devices/*', authenticate);
router.all('/chat/*', authenticate);

// Health check endpoint
router.get('/health', () => json({ status: 'ok', timestamp: new Date().toISOString() }));

// OpenAPI specification endpoint
router.get('/openapi.json', () => {
    const openApiService = new OpenAPIService();
    return json(openApiService.generateSpec());
});

// Documentation endpoints
router.get('/docs', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const format = url.searchParams.get('format') || 'html';
    const docs = new ApiDocumentation();

    switch (format) {
        case 'markdown':
            return new Response(docs.generateMarkdown(), {
                headers: { 'Content-Type': 'text/markdown' }
            });
        case 'openapi':
            return new Response(JSON.stringify(docs.generateOpenApiSpec(), null, 2), {
                headers: { 'Content-Type': 'application/json' }
            });
        default:
            return new Response(docs.generateHtml(), {
                headers: { 'Content-Type': 'text/html' }
            });
    }
});

// Device endpoints
router.all('/api/devices*', async (request: Request, env: Env) => {
    const handler = new DeviceHandler(env);
    try {
        return await handler.handleRequest(request);
    } catch (err) {
        console.error('Devices endpoint error:', err);
        return error(502, {
            error: 'Failed to handle devices request',
            details: err instanceof Error ? err.message : String(err)
        });
    }
});

// Camera endpoints
router.get('/api/camera/use-cases', () => json({ use_cases: getAvailableUseCases() }));
router.get('/api/camera/organization', async (request: Request, env: Env) => {
    const organization = await buildCameraOrganization(env);
    return json({ organization });
});

// Analysis endpoints
router.post('/api/analysis/custom', async (request: Request, env: Env) => {
    const handler = new AnalysisHandler(env);
    return await handler.handleCustomAnalysis(request);
});

router.post('/api/analysis/:promptType/:category', async (request: Request & { params: Record<string, string> }, env: Env) => {
    const handler = new AnalysisHandler(env);
    const { promptType, category } = request.params;
    const requestId = request.headers.get('cf-request-id') || crypto.randomUUID();
    return await handler.handlePredefinedAnalysis(promptType as PromptType, category, requestId);
});

// States endpoints with enhanced error handling
router.all('/api/states*', async (request: Request, env: Env) => {
    const handler = new EnhancedStatesHandler(env);
    try {
        return await handler.handleRequest(request);
    } catch (err) {
        console.error('States endpoint error:', err);
        return error(502, {
            error: 'Failed to handle states request',
            details: err instanceof Error ? err.message : String(err)
        });
    }
});

// Chat history endpoint
router.get('/api/chat/history', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const searchQuery = url.searchParams.get('query') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    try {
        return await queryChatHistory(env.DB, searchQuery, limit);
    } catch (err) {
        return error(500, {
            error: 'Failed to query chat history',
            details: err instanceof Error ? err.message : String(err)
        });
    }
});

// Home Assistant API passthrough with enhanced error handling
const hassioApiService = new HassioApiService({ proxyToHomeAssistant });

router.all('/api/hassio/*', async (request: Request, env: Env) => {
    try {
        return await hassioApiService.proxyToHomeAssistant(request, env);
    } catch (err) {
        return error(502, {
            error: 'Home Assistant proxy request failed',
            details: err instanceof Error ? err.message : String(err)
        });
    }
});

// 404 handler
router.all('*', () => error(404, 'Not Found'));

// Cloudflare Worker Handler
export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        try {
            // Log request asynchronously
            ctx.waitUntil(logRequest(env.DB, request));

            // Validate required environment variables
            if (!env.HASSIO_URL || !env.HASSIO_TOKEN || !env.CF_API_KEY) {
                throw new Error('Missing required environment variables');
            }

            // Try to handle the request through the router
            const response = await router.handle(request, env);
            if (response) {
                return response;
            }

            // If no response was generated, return 404
            return error(404, 'Not Found');

        } catch (err: unknown) {
            console.error('Worker Error:', err);

            // Handle specific error types
            if (err instanceof Error) {
                if (err.message === 'Unauthorized') {
                    return error(401, 'Unauthorized');
                }
                if (err.message === 'Missing required environment variables') {
                    return error(500, 'Server configuration error');
                }
            }

            // Handle generic errors
            return error(500, {
                error: 'Internal server error',
                details: err instanceof Error ? err.message : 'Unknown error'
            });
        }
    }
} satisfies ExportedHandler<Env>;
```

# File: ./handlers/devices.ts

```typescript
import { CameraAnalysisService } from '../services/camera-analysis.service';
import { HassioApiService } from '../services/hassio.service';
import {
    CameraDevice,
    CameraSnapshotResponse,
    DeviceListResponse,
    Env,
    ErrorResponse,
    HomeAssistantDeviceState,
    PromptType
} from '../types';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';

export class DeviceHandler {
    private apiService: HassioApiService;
    private analysisService: CameraAnalysisService;
    private readonly BATCH_SIZE = 3;

    constructor(private readonly env: Env) {
        // COMMENTED OUT original implementation that could cause circular reference
        // this.apiService = new HassioApiService({ proxyToHomeAssistant });

        // NEW implementation to break circular reference
        this.apiService = new HassioApiService({
            proxyToHomeAssistant: async (request: Request, env: Env) => {
                try {
                    const url = new URL(request.url);
                    const newUrl = new URL(url.pathname + url.search, env.HASSIO_URL);
                    const headers = new Headers(request.headers);
                    headers.set('Authorization', `Bearer ${env.HASSIO_TOKEN}`);
                    
                    const newRequest = new Request(newUrl.toString(), {
                        method: request.method,
                        headers,
                        body: request.body
                    });
                    
                    return await fetch(newRequest);
                } catch (error) {
                    console.error('Proxy error:', error);
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Failed to proxy request',
                        details: error instanceof Error ? error.message : String(error)
                    }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
        });
        this.analysisService = new CameraAnalysisService(env);
    }

    // ... [ALL REMAINING CODE STAYS EXACTLY THE SAME] ...
}```

# File: ./handlers/enhanced-states.ts

```typescript
import { Env } from '../types';
import { error, json } from '../utils/response';

interface WebSocketClient {
    socket: WebSocket;
    subscriptions: Set<string>;
    lastPing: number;
}

export class EnhancedStatesHandler {
    private webSocketClients: Map<string, WebSocketClient> = new Map();
    private readonly PING_INTERVAL = 30000; // 30 seconds
    private readonly MAX_CLIENTS = 100;

    constructor(private readonly env: Env) {
        this.startPingInterval();
    }

    async handleRequest(request: Request): Promise<Response> {
        try {
            const url = new URL(request.url);

            // Handle WebSocket upgrades
            if (url.pathname === '/api/websocket' && request.headers.get('Upgrade') === 'websocket') {
                return this.handleWebSocketUpgrade(request);
            }

            // Handle regular state requests
            if (url.pathname.startsWith('/api/states')) {
                const response = await this.handleStateRequest(request);
                
                // Check if response is ok and has valid JSON
                if (!response.ok) {
                    const text = await response.text();
                    return error(response.status, {
                        error: 'Failed to fetch states from Home Assistant',
                        status: response.status,
                        details: text
                    });
                }

                try {
                    const data = await response.json();
                    return json({
                        success: true,
                        states: data
                    });
                } catch (parseError) {
                    console.error('Error parsing states response:', parseError);
                    return error(502, {
                        error: 'Invalid response from Home Assistant',
                        details: parseError instanceof Error ? parseError.message : String(parseError)
                    });
                }
            }

            return error(404, 'Not Found');
        } catch (err) {
            console.error('EnhancedStatesHandler error:', err);
            return error(500, {
                error: 'Internal server error',
                details: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private handleWebSocketUpgrade(request: Request): Response {
        // Check client limit
        if (this.webSocketClients.size >= this.MAX_CLIENTS) {
            return error(503, 'Too Many Connections');
        }

        try {
            const pair = new WebSocketPair();
            const client: WebSocketClient = {
                socket: pair[1],
                subscriptions: new Set(),
                lastPing: Date.now()
            };

            // Set up the client socket
            client.socket.addEventListener('message', (event) => {
                this.handleWebSocketMessage(client, event);
            });

            client.socket.addEventListener('close', () => {
                this.webSocketClients.delete(pair[1].url);
            });

            client.socket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                this.webSocketClients.delete(pair[1].url);
            });

            this.webSocketClients.set(pair[1].url, client);

            // Accept the connection
            pair[1].accept();

            return new Response(null, {
                status: 101,
                webSocket: pair[0]
            });
        } catch (err) {
            console.error('WebSocket upgrade error:', err);
            return error(500, {
                error: 'Failed to establish WebSocket connection',
                details: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private async handleWebSocketMessage(client: WebSocketClient, event: MessageEvent) {
        try {
            const message = JSON.parse(event.data as string);

            switch (message.type) {
                case 'subscribe':
                    if (Array.isArray(message.entities)) {
                        message.entities.forEach((entity: string) => {
                            client.subscriptions.add(entity);
                        });
                        client.socket.send(JSON.stringify({
                            type: 'subscribed',
                            entities: Array.from(client.subscriptions)
                        }));
                    }
                    break;

                case 'unsubscribe':
                    if (Array.isArray(message.entities)) {
                        message.entities.forEach((entity: string) => {
                            client.subscriptions.delete(entity);
                        });
                        client.socket.send(JSON.stringify({
                            type: 'unsubscribed',
                            entities: message.entities
                        }));
                    }
                    break;

                case 'pong':
                    client.lastPing = Date.now();
                    break;

                default:
                    client.socket.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type'
                    }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            client.socket.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    }

    private startPingInterval() {
        setInterval(() => {
            const now = Date.now();
            this.webSocketClients.forEach((client, url) => {
                if (now - client.lastPing > this.PING_INTERVAL * 2) {
                    // Client hasn't responded to ping, close connection
                    client.socket.close(1000, 'Ping timeout');
                    this.webSocketClients.delete(url);
                } else {
                    // Send ping
                    client.socket.send(JSON.stringify({ type: 'ping' }));
                }
            });
        }, this.PING_INTERVAL);
    }

    private async handleStateRequest(request: Request): Promise<Response> {
        try {
            // Use HASSIO_URL consistently
            const response = await fetch(`${this.env.HASSIO_URL}/api/states`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.env.HASSIO_TOKEN}`,
                    'Accept': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });

            // Add response validation
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Home Assistant error response:', {
                    status: response.status,
                    body: errorText
                });
                
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Failed to fetch states from Home Assistant',
                    status: response.status,
                    details: errorText
                }), {
                    status: response.status,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    }
                });
            }

            // Validate the response is JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid response from Home Assistant',
                    details: 'Expected JSON response'
                }), {
                    status: 502,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    }
                });
            }

            const states = await response.json();
            return new Response(JSON.stringify({
                success: true,
                states: states
            }), {
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });

        } catch (err) {
            console.error('Error fetching states:', err);
            return new Response(JSON.stringify({
                success: false,
                error: 'Failed to fetch states',
                details: err instanceof Error ? err.message : String(err)
            }), {
                status: 502,
                headers: { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store'
                }
            });
        }
    }
}
```

# File: ./handlers/analysis.ts

```typescript
import { CameraAnalysisService } from '../services/camera-analysis.service';
import { HassioApiService } from '../services/hassio.service';
import { Env, PromptLibrary, PromptType } from '../types';
import { AnalysisContext, AnalysisResponse, CustomAnalysisRequest, DeviceAnalysisData } from '../types/analysis';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { getPrompt } from '../utils/prompts';

export class AnalysisHandler {
    private apiService: HassioApiService;
    private analysisService: CameraAnalysisService;
    private readonly BATCH_SIZE = 3;

    constructor(private readonly env: Env) {
        this.analysisService = new CameraAnalysisService(env);
        this.apiService = new HassioApiService({ proxyToHomeAssistant });
    }

    /**
     * Handle predefined analysis types using PROMPT_LIBRARY
     */
    async handlePredefinedAnalysis(
        promptType: string,
        category: string,
        requestId: string
    ): Promise<Response> {
        try {
            // Get prompt data
            const promptData = getPrompt(
                promptType as PromptType,
                category as keyof PromptLibrary[PromptType]
            );
            if (!promptData || Array.isArray(promptData)) {
                throw new Error(`Invalid prompt type or category: ${String(promptType)}/${String(category)}`);
            }

            // Gather data for all specified devices
            const devicesData = await this.gatherDevicesData(promptData.devices, requestId);

            // Create analysis context
            const context: AnalysisContext = {
                devices: devicesData,
                prompt: promptData.prompt,
                prompt_type: promptType as PromptType,
                category: String(category),
                request_id: requestId
            };

            // Run analysis
            return await this.runAnalysis(context);

        } catch (error) {
            return this.errorResponse('Failed to run predefined analysis', error, requestId);
        }
    }

    /**
     * Handle custom analysis requests
     */
    async handleCustomAnalysis(request: Request): Promise<Response> {
        const requestId = request.headers.get('cf-request-id') || crypto.randomUUID();

        try {
            // Parse request body
            const body = await request.json() as CustomAnalysisRequest;
            if (!body?.prompt_template?.devices || !body?.prompt_template?.prompt) {
                throw new Error('Invalid request body: missing devices or prompt');
            }

            // Gather data for specified devices
            const devicesData = await this.gatherDevicesData(body.prompt_template.devices, requestId);

            // Create analysis context
            const context: AnalysisContext = {
                devices: devicesData,
                prompt: body.prompt_template.prompt,
                request_id: requestId
            };

            // Run analysis
            return await this.runAnalysis(context);

        } catch (error) {
            return this.errorResponse('Failed to run custom analysis', error, requestId);
        }
    }

    /**
     * Gather data (snapshots and states) for specified devices
     */
    private async gatherDevicesData(devices: string[], requestId: string): Promise<DeviceAnalysisData[]> {
        const devicePromises = devices.map(async (deviceId) => {
            try {
                // Get device state
                const stateResponse = await this.apiService.getEntityState(this.env, deviceId);
                if (!stateResponse.ok) {
                    throw new Error(`Failed to fetch device state: ${stateResponse.status}`);
                }
                const state = await stateResponse.json();

                // For cameras, also get snapshot
                if (deviceId.startsWith('camera.')) {
                    const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${deviceId}`;
                    let snapshot_base64 = '';
                    try {
                        snapshot_base64 = await getBase64Snapshot(snapshotUrl, deviceId);
                    } catch (error) {
                        console.error(`[${requestId}] Failed to get snapshot for ${deviceId}:`, error);
                    }

                    return {
                        device_id: deviceId,
                        snapshot_base64,
                        snapshot_url: snapshotUrl,
                        state
                    };
                }

                // For non-camera devices, just return state
                return {
                    device_id: deviceId,
                    state
                };

            } catch (error) {
                console.error(`[${requestId}] Failed to gather data for ${deviceId}:`, error);
                return {
                    device_id: deviceId,
                    state: { error: 'Failed to gather device data' }
                };
            }
        });

        return await Promise.all(devicePromises);
    }

    /**
     * Run analysis on gathered device data
     */
    private async runAnalysis(context: AnalysisContext): Promise<Response> {
        try {
            const results = [];
            const timestamp = new Date().toISOString();

            // Process devices in batches
            for (let i = 0; i < context.devices.length; i += this.BATCH_SIZE) {
                const batch = context.devices.slice(i, i + this.BATCH_SIZE);
                console.log(`[${context.request_id}] Processing batch ${Math.floor(i/this.BATCH_SIZE) + 1} of ${Math.ceil(context.devices.length/this.BATCH_SIZE)}`);

                // Run AI analysis on batch
                const batchResults = await Promise.all(
                    batch.map(async (device) => {
                        try {
                            // For cameras, use vision AI
                            if (device.device_id.startsWith('camera.') && device.snapshot_base64) {
                                const analysis = await this.analysisService.analyzeSingleCamera(
                                    device.device_id,
                                    {
                                        success: true,
                                        snapshot_base64: device.snapshot_base64,
                                        snapshot_url: device.snapshot_url || ''
                                    },
                                    device.snapshot_url || '',
                                    context.prompt_type || 'general_status'
                                );

                                return {
                                    device_id: device.device_id,
                                    analysis: analysis.description,
                                    timestamp,
                                    snapshot_url: device.snapshot_url,
                                    state: device.state
                                };
                            }

                            // For non-camera devices, just include state
                            return {
                                device_id: device.device_id,
                                analysis: 'Non-camera device state recorded',
                                timestamp,
                                state: device.state
                            };

                        } catch (error) {
                            console.error(`[${context.request_id}] Analysis failed for ${device.device_id}:`, error);
                            return {
                                device_id: device.device_id,
                                analysis: 'Analysis failed',
                                timestamp,
                                error: error instanceof Error ? error.message : String(error)
                            };
                        }
                    })
                );

                results.push(...batchResults);

                // Optional delay between batches
                if (i + this.BATCH_SIZE < context.devices.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            const response: AnalysisResponse = {
                success: true,
                request_id: context.request_id,
                results
            };

            return new Response(JSON.stringify(response), {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': context.request_id
                }
            });

        } catch (error) {
            return this.errorResponse('Analysis failed', error, context.request_id);
        }
    }

    private errorResponse(message: string, error: unknown, requestId?: string): Response {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[${requestId || 'unknown'}] ${message}:`, error);

        const response: AnalysisResponse = {
            success: false,
            request_id: requestId || 'unknown',
            results: [],
            error: message,
            details: errorMessage
        };

        return new Response(JSON.stringify(response), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                ...(requestId && { 'X-Request-ID': requestId })
            }
        });
    }
}
```

# File: ./services/camera-analysis.service.ts

```typescript
/**
 * @fileoverview Camera Analysis Service using Cloudflare AI
 * Provides AI-powered visual analysis of camera feeds
 */

import {
    AiResponse,
    CameraAnalysisResult,
    CameraDevice,
    CameraSnapshotResponse,
    Env,
    HomeAssistantProxy,
    PromptType
} from '../types';
import { HassioApiService } from './hassio.service';
import { getCameraInfo, getCamerasByGroup, getCamerasByUseCase } from '../utils/camera';
import { CameraMetadata } from '../types';
import { getPrompt, getPromptCategoryForCamera } from '../utils/prompts';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { selectAIModel } from '../utils/model-selector';

export class CameraAnalysisService {
    private model: string;
    private memoryUsage: { [key: string]: number } = {};

    private apiService: HassioApiService;

    /**
     * Converts CameraMetadata to CameraDevice
     */
    private metadataToDevice(camera: CameraMetadata): CameraDevice {
        return {
            entity_id: camera.camera_id,
            state: camera.state,
            attributes: camera.attributes,
            friendly_name: camera.camera_id,
            motion_detection: false,
            stream_type: "unknown",
            width: 0,
            height: 0,
            fps: 0,
            bitrate: 0,
            channel_id: '',
            attribution: "Unknown",
            supported_features: 0,
            last_changed: new Date().toISOString(),
            last_updated: new Date().toISOString(),
            last_reported: new Date().toISOString(),
            snapshot_url: camera.snapshot_data.snapshot_url,
            stream_url: `${this.env.HASSIO_URL}/api/camera_proxy_stream/${camera.camera_id}`,
            snapshot_base64: camera.snapshot_data.snapshot_base64,
            snapshot_data: camera.snapshot_data,
            prompt_class: 'general_status'
        };
    }

    constructor(private readonly env: Env) {
        this.model = selectAIModel('image_analysis');
        this.apiService = new HassioApiService({ proxyToHomeAssistant: proxyToHomeAssistant });
    }

    /**
     * Analyzes a single camera feed using AI vision model with optimized memory usage
     */
    async analyzeSingleCamera(
        cameraId: string,
        snapshotData: CameraSnapshotResponse,
        stream_url: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult> {
        const startTime = performance.now();
        try {
            if (!snapshotData.success || !snapshotData.snapshot_base64) {
                throw new Error(`Failed to get snapshot for camera ${cameraId}`);
            }

            // Get prompt data first to fail fast if invalid
            const promptCategories = getPromptCategoryForCamera(cameraId, prompt_class);
            if (!promptCategories.length) {
                throw new Error(`No valid prompt category found for camera ${cameraId}`);
            }

            const { category } = promptCategories[0];
            const promptData = getPrompt(prompt_class, category);
            if (!promptData || Array.isArray(promptData)) {
                throw new Error(`No valid prompt found for camera ${cameraId} in class ${prompt_class}`);
            }

            // Get camera metadata
            const metadata = await getCameraInfo(this.env, this.apiService, cameraId);
            const cameraMetadata = Array.isArray(metadata)
                ? metadata.find(cam => cam.camera_id === cameraId)
                : metadata;

            if (!cameraMetadata) {
                throw new Error(`No metadata found for camera ${cameraId}`);
            }

            // Construct minimal system prompt
            const systemPrompt = `You are a security camera analyst focused on ${promptData.description}. Location: ${cameraMetadata.location} (${cameraMetadata.floor}). Group: ${cameraMetadata.group}. Key zones: ${cameraMetadata.key_zones.join(", ")}.`;

            // Run AI analysis
            const aiResponse = await this.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `data:image/jpeg;base64,${snapshotData.snapshot_base64}` },
                    { role: 'user', content: promptData.prompt }
                ]
            }) as AiResponse;

            return {
                camera_id: cameraId,
                description: aiResponse.response,
                snapshot_url: snapshotData.snapshot_url,
                stream_url,
                snapshot_base64: snapshotData.snapshot_base64,
                timestamp: new Date().toISOString()
            };
        } finally {
            const endTime = performance.now();
            this.memoryUsage[cameraId] = endTime - startTime;
        }
    }

    /**
     * Analyzes multiple cameras with batched processing and memory optimization
     */
    async analyzeCameras(
        cameras: CameraDevice[],
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        try {
            const results: CameraAnalysisResult[] = [];
            const batchSize = 3; // Process cameras in smaller batches

            for (let i = 0; i < cameras.length; i += batchSize) {
                const batch = cameras.slice(i, i + batchSize);
                console.log(`Processing batch ${i/batchSize + 1} of ${Math.ceil(cameras.length/batchSize)}`);

                const batchResults = await Promise.all(
                    batch.map(camera =>
                        this.analyzeSingleCamera(
                            camera.entity_id,
                            {
                                success: true,
                                snapshot_base64: camera.snapshot_base64,
                                snapshot_url: camera.snapshot_url
                            },
                            camera.stream_url,
                            prompt_class
                        ).catch(error => {
                            console.error(`Error analyzing camera ${camera.entity_id}:`, error);
                            return null;
                        })
                    )
                );

                results.push(...batchResults.filter((result): result is CameraAnalysisResult => result !== null));

                // Log memory usage after each batch
                console.log('Memory usage for batch:',
                    batch.map(camera => ({
                        camera: camera.entity_id,
                        time: this.memoryUsage[camera.entity_id]
                    }))
                );

                // Optional: Add delay between batches if needed
                if (i + batchSize < cameras.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            return results;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('Error analyzing cameras:', error);
            throw new Error(`Failed to analyze cameras: ${errorMessage}`);
        }
    }

    /**
     * Analyzes cameras by group
     */
    async analyzeCamerasByGroup(
        group: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        const cameras = await getCamerasByGroup(this.env, this.apiService, group);
        const cameraDevices = cameras.map((camera: CameraMetadata) => this.metadataToDevice(camera));
        return this.analyzeCameras(cameraDevices, prompt_class);
    }

    /**
     * Analyzes cameras by use case
     */
    async analyzeCamerasByUseCase(
        useCase: string,
        prompt_class: PromptType
    ): Promise<CameraAnalysisResult[]> {
        const cameras = await getCamerasByUseCase(this.env, this.apiService, useCase);
        const cameraDevices = cameras.map((camera: CameraMetadata) => this.metadataToDevice(camera));
        return this.analyzeCameras(cameraDevices, prompt_class);
    }
}
```

# File: ./services/documentation.service.ts

```typescript
interface Parameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface RequestBody {
  type: string;
  example: Record<string, any>;
}

interface ResponseFormat {
  example: Record<string, any> | string;
}

interface Endpoint {
  path: string;
  method: string;
  description: string;
  auth_required: boolean;
  parameters?: Parameter[];
  request_body?: RequestBody;
  response_format?: ResponseFormat;
  notes?: string;
}

interface Documentation {
  api_endpoints: Endpoint[];
  custom_endpoints: Endpoint[];
  system_endpoints: Endpoint[];
}

interface SecurityScheme {
  type: string;
  in?: string;
  name?: string;
  scheme?: string;
  description?: string;
}

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  components: {
    securitySchemes: {
      CloudflareApiKey: SecurityScheme;
      HassioToken: SecurityScheme;
    };
  };
  paths: Record<string, any>;
}

export class ApiDocumentation {
  getEndpointDocs(): Documentation {
    return {
      api_endpoints: [
        {
          path: "/api/",
          method: "GET",
          description: "API Discovery endpoint",
          auth_required: true,
          parameters: [],
          response_format: {
            example: {
              "message": "API running"
            }
          }
        },
        {
          path: "/api/config",
          method: "GET",
          description: "Get Home Assistant configuration",
          auth_required: true,
          parameters: [],
          response_format: {
            example: {
              "location_name": "Home",
              "latitude": 0,
              "longitude": 0,
              "elevation": 0,
              "unit_system": {
                "length": "km",
                "mass": "kg",
                "temperature": "°C",
                "volume": "L"
              },
              "time_zone": "UTC",
              "components": [],
              "config_dir": "/config",
              "whitelist_external_dirs": [],
              "allowlist_external_dirs": [],
              "allowlist_external_urls": [],
              "version": "2024.1.0"
            }
          }
        },
        {
          path: "/api/camera_proxy/{camera_id}",
          method: "GET",
          description: "Get camera snapshot",
          auth_required: true,
          parameters: [{
            name: "camera_id",
            type: "string",
            description: "Camera entity ID",
            required: true
          }],
          response_format: {
            example: "Binary image data"
          }
        },
        {
          path: "/api/camera_proxy_stream/{camera_id}",
          method: "GET",
          description: "Get camera stream",
          auth_required: true,
          parameters: [{
            name: "camera_id",
            type: "string",
            description: "Camera entity ID",
            required: true
          }],
          response_format: {
            example: "Video stream data"
          }
        }
      ],
      custom_endpoints: [
        {
          path: "/devices",
          method: "GET",
          description: "Get all devices (filtered)",
          auth_required: true,
          notes: "Excludes device_tracker entities",
          response_format: {
            example: {
              devices: [
                {
                  entity_id: "light.living_room",
                  state: "on",
                  attributes: {
                    friendly_name: "Living Room Light"
                  }
                }
              ],
              count: 1
            }
          }
        },
        {
          path: "/devices/cameras",
          method: "GET",
          description: "Get all camera devices with enhanced information",
          auth_required: true,
          response_format: {
            example: {
              devices: [{
                entity_id: "camera.front_door",
                state: "recording",
                attributes: {
                  friendly_name: "Front Door Camera"
                },
                snapshot_url: "https://hassio-api.hacolby.workers.dev/api/camera_proxy/camera.front_door",
                stream_url: "https://hassio-api.hacolby.workers.dev/api/camera_proxy_stream/camera.front_door",
                snapshot_base64: "base64_encoded_image_data..."
              }],
              count: 1
            }
          }
        },
        {
          path: "/chat",
          method: "POST",
          description: "AI-powered security analysis and automation",
          auth_required: true,
          request_body: {
            type: "json",
            example: {
              message: "Perform a security check",
              session_id: "security-123"
            }
          },
          response_format: {
            example: {
              role: "assistant",
              content: {
                car_parked: true,
                garage_door_open: false,
                vehicle_details: {
                  make: "Toyota",
                  model: "Camry",
                  color: "Silver",
                  license_plate: "ABC123"
                },
                person_at_door: false,
                package_present: true,
                package_details: {
                  type: "Amazon",
                  appearance: "Large brown box"
                },
                people_present: false,
                dogs_present: true,
                dog_details: {
                  breed: ["French Bulldog"],
                  activity: "Sleeping on couch"
                },
                robot_status: {
                  operating: true,
                  stuck: false
                },
                roof_water_present: false,
                suspicious_activity: false
              }
            }
          },
          notes: "Integrates with Home Assistant for automated security responses including camera analysis and notifications"
        }
      ],
      system_endpoints: [
        {
          path: "/cf-worker/health",
          method: "GET",
          description: "System health check",
          auth_required: false,
          response_format: {
            example: {
              "API Key Verification": {
                "passed": true
              },
              "HomeAssistant Connection": {
                "passed": true,
                "note": "Connected to Home"
              }
            }
          }
        }
      ]
    };
  }

  generateMarkdown(): string {
    const docs = this.getEndpointDocs();
    let markdown = '# Home Assistant API Worker Documentation\n\n';

    markdown += '## Authentication\n\n';
    markdown += 'Authentication is handled in two ways:\n\n';
    markdown += '1. Cloudflare-specific endpoints (/cf-worker/*, /devices/*, /chat) require an API key in the X-Api-Key header\n';
    markdown += '2. Home Assistant API endpoints (/api/*) require a Bearer token in the Authorization header\n\n';

    markdown += '## Security Features\n\n';
    markdown += 'The API includes AI-powered security features:\n\n';
    markdown += '- Automated garage door monitoring\n';
    markdown += '- Package and delivery detection\n';
    markdown += '- Camera feed analysis\n';
    markdown += '- Indoor monitoring with pet detection\n';
    markdown += '- Roof condition monitoring\n';
    markdown += '- Automated security responses\n\n';

    markdown += '## Camera Integration\n\n';
    markdown += 'Camera endpoints provide:\n\n';
    markdown += '- Direct snapshot access\n';
    markdown += '- Live video streaming\n';
    markdown += '- Base64 encoded snapshots\n';
    markdown += '- AI-powered scene analysis\n\n';

    markdown += '## API Endpoints\n\n';
    docs.api_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      markdown += `- Method: ${endpoint.method}\n`;
      markdown += `- Description: ${endpoint.description}\n`;
      markdown += `- Authentication Required: ${endpoint.auth_required}\n`;

      if (endpoint.notes) {
        markdown += `- Notes: ${endpoint.notes}\n`;
      }

      if (endpoint.parameters && endpoint.parameters.length > 0) {
        markdown += '\nParameters:\n';
        endpoint.parameters.forEach(param => {
          markdown += `- ${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}\n`;
        });
      }

      if (endpoint.request_body) {
        markdown += '\nRequest Body Example:\n```json\n';
        markdown += JSON.stringify(endpoint.request_body.example, null, 2);
        markdown += '\n```\n';
      }

      if (endpoint.response_format) {
        markdown += '\nResponse Format Example:\n```json\n';
        markdown += JSON.stringify(endpoint.response_format.example, null, 2);
        markdown += '\n```\n';
      }

      markdown += '\n';
    });

    markdown += '## Custom Endpoints\n\n';
    docs.custom_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      // ... similar to API endpoints
    });

    markdown += '## System Endpoints\n\n';
    docs.system_endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.path}\n`;
      // ... similar to API endpoints
    });

    return markdown;
  }

  generateHtml(): string {
    const docs = this.getEndpointDocs();
    let html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Home Assistant API Worker Documentation</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
              line-height: 1.6;
              max-width: 1200px;
              margin: 0 auto;
              padding: 20px;
              color: #333;
            }
            h1, h2, h3 { color: #2c3e50; }
            .endpoint {
              background: #f8f9fa;
              border: 1px solid #dee2e6;
              border-radius: 4px;
              padding: 20px;
              margin: 20px 0;
            }
            .method {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-weight: bold;
            }
            .get { background: #e3f2fd; }
            .post { background: #e8f5e9; }
            .auth-type {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 0.9em;
              margin-left: 8px;
            }
            .auth-cloudflare {
              background: #f0ad4e;
              color: white;
            }
            .auth-hassio {
              background: #5bc0de;
              color: white;
            }
            pre {
              background: #f5f5f5;
              padding: 10px;
              border-radius: 4px;
              overflow-x: auto;
            }
            .notes {
              background: #fff3e0;
              padding: 10px;
              border-radius: 4px;
              margin: 10px 0;
            }
            .security-features {
              background: #e8eaf6;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
            }
            .camera-integration {
              background: #e0f2f1;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
            }
          </style>
        </head>
        <body>
          <h1>Home Assistant API Worker Documentation</h1>

          <section class="security-features">
            <h2>Security Features</h2>
            <ul>
              <li>AI-powered security analysis</li>
              <li>Automated garage door monitoring</li>
              <li>Package and delivery detection</li>
              <li>Camera feed analysis</li>
              <li>Indoor monitoring with pet detection</li>
              <li>Roof condition monitoring</li>
            </ul>
          </section>

          <section class="camera-integration">
            <h2>Camera Integration</h2>
            <ul>
              <li>Direct snapshot access</li>
              <li>Live video streaming</li>
              <li>Base64 encoded snapshots</li>
              <li>AI-powered scene analysis</li>
            </ul>
          </section>

          <h2>API Endpoints</h2>
          ${docs.api_endpoints.map(endpoint => `
            <div class="endpoint">
              <h3>${endpoint.path}</h3>
              <span class="method ${endpoint.method.toLowerCase()}">${endpoint.method}</span>
              <span class="auth-type ${endpoint.path.startsWith('/api/') ? 'auth-hassio' : 'auth-cloudflare'}">
                ${endpoint.path.startsWith('/api/') ? 'Bearer Token' : 'API Key'}
              </span>
              <p>${endpoint.description}</p>
              ${endpoint.notes ? `<div class="notes">${endpoint.notes}</div>` : ''}
              ${endpoint.parameters ? `
                <h4>Parameters</h4>
                <ul>
                  ${endpoint.parameters.map(param => `
                    <li>${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}</li>
                  `).join('')}
                </ul>
              ` : ''}
              ${endpoint.request_body ? `
                <h4>Request Body Example</h4>
                <pre><code>${JSON.stringify(endpoint.request_body.example, null, 2)}</code></pre>
              ` : ''}
              ${endpoint.response_format ? `
                <h4>Response Format Example</h4>
                <pre><code>${JSON.stringify(endpoint.response_format.example, null, 2)}</code></pre>
              ` : ''}
            </div>
          `).join('')}
        </body>
      </html>
    `;

    return html;
  }

  generateOpenApiSpec(): OpenApiSpec {
    const docs = this.getEndpointDocs();
    const spec: OpenApiSpec = {
      openapi: '3.0.0',
      info: {
        title: 'Home Assistant API Worker',
        version: '1.0.0',
        description: 'API for interacting with Home Assistant through Cloudflare Worker'
      },
      servers: [
        {
          url: 'https://hassio-api.hacolby.workers.dev',
          description: 'Production server'
        }
      ],
      components: {
        securitySchemes: {
          CloudflareApiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Api-Key',
            description: 'API key for Cloudflare-specific endpoints'
          },
          HassioToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'Bearer token for Home Assistant API endpoints'
          }
        }
      },
      paths: {}
    };

    // Convert endpoints to OpenAPI format
    [...docs.api_endpoints, ...docs.custom_endpoints, ...docs.system_endpoints].forEach(endpoint => {
      spec.paths[endpoint.path] = {
        [endpoint.method.toLowerCase()]: {
          summary: endpoint.description,
          security: endpoint.auth_required ? [
            endpoint.path.startsWith('/api/') ? { HassioToken: [] } : { CloudflareApiKey: [] }
          ] : [],
          parameters: endpoint.parameters?.map(param => ({
            name: param.name,
            in: 'path',
            required: param.required,
            schema: {
              type: param.type.toLowerCase()
            },
            description: param.description
          })) || [],
          requestBody: endpoint.request_body ? {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  example: endpoint.request_body.example
                }
              }
            }
          } : undefined,
          responses: {
            '200': {
              description: 'Successful response',
              content: endpoint.response_format ?
                typeof endpoint.response_format.example === 'string' ?
                  {
                    [endpoint.path.includes('camera_proxy_stream') ?
                      'video/*' :
                      'image/*']: {
                      schema: {
                        type: 'string',
                        format: 'binary'
                      }
                    }
                  } :
                  {
                    'application/json': {
                      schema: {
                        type: 'object',
                        example: endpoint.response_format.example
                      }
                    }
                  }
                : {}
            }
          }
        }
      };
    });

    return spec;
  }
}
```

# File: ./services/security.ts

```typescript
/**
 * @fileoverview Security Worker module for handling Home Assistant security features
 * This module provides AI-powered security analysis and automation for Home Assistant
 * including camera monitoring, garage automation, and security notifications.
 */

import { CameraAnalysisResult, Env, SecurityPatrolResult, SecurityResult } from '../types';
import { getBase64Snapshot } from '../utils/camera';
import { proxyToHomeAssistant } from '../utils/homeassistant-proxy';
import { PROMPT_LIBRARY } from '../utils/prompts';
import { CameraAnalysisService } from './camera-analysis.service';

/**
 * SecurityWorker class handles all security-related operations including
 * AI-powered analysis, camera monitoring, and automated security responses.
 */
export class SecurityWorker {
    private cameraAnalysisService: CameraAnalysisService;

    /**
     * Creates a new SecurityWorker instance
     * @param env - Environment variables and bindings
     */
    constructor(private readonly env: Env) {
        this.cameraAnalysisService = new CameraAnalysisService(env);
    }

    /**
     * Processes security findings and triggers appropriate automations
     * @param result - Security analysis results
     */
    private async handleSecurityFindings(result: SecurityResult): Promise<void> {
        // Garage & Vehicle Automation
        if (result.car_parked && result.garage_door_open) {
            await this.env.call('input_boolean.car_and_door_open', true);
        } else if (result.car_parked && !result.garage_door_open) {
            await this.env.call('input_boolean.car_and_door_closed', true);
        } else if (!result.car_parked && result.garage_door_open) {
            await this.env.call('input_boolean.no_car_and_door_open', true);
        } else if (!result.car_parked && !result.garage_door_open) {
            await this.env.call('input_boolean.no_car_and_door_closed', true);
        }

        // Package & Delivery Notifications
        if (result.person_at_door || result.package_present) {
            await this.env.call('notify.admin', {
                message: `Delivery Alert: ${
                    result.is_delivery_person ? 'Delivery person present' :
                    result.package_present ? 'Package detected' : 'Person at door'
                }`,
                data: {
                    details: result.person_description || result.package_details
                }
            });
        }

        // Indoor Monitoring
        if (result.robot_status?.stuck) {
            await this.env.call('notify.admin', {
                message: `Robot Stuck: Check ${result.robot_status.location}`
            });
        }

        // Roof Monitoring
        if (result.roof_water_present) {
            await this.env.call('notify.admin', {
                message: 'Roof Alert: Standing water detected',
                data: result.roof_water_details
            });
        }

        // General Security Alerts
        if (result.suspicious_activity) {
            await this.env.call('notify.admin', {
                message: `Security Alert: ${result.suspicious_activity_details}`
            });
        }
    }

    /**
     * Performs a security patrol by analyzing all security-related cameras
     * @returns Comprehensive security patrol results
     */
    private async performSecurityPatrol(): Promise<SecurityPatrolResult> {
        const patrolResult: SecurityPatrolResult = {
            timestamp: new Date().toISOString(),
            entry_points: { status: 'pending', details: '' },
            package_detection: { status: 'pending', details: '' },
            vehicle_monitoring: { status: 'pending', details: '' },
            indoor_monitoring: { status: 'pending', details: '' },
            roof_monitoring: { status: 'pending', details: '' },
            door_status: { status: 'pending', details: '' },
            garage_monitoring: { status: 'pending', details: '' },
            overall_security_status: 'secure',
            alerts: []
        };

        try {
            // Process each security category
            const categories = Object.keys(PROMPT_LIBRARY.security_analysis) as Array<keyof typeof PROMPT_LIBRARY.security_analysis>;
            for (const category of categories) {
                if (category === 'automated_security_sweep') continue;

                const promptData = PROMPT_LIBRARY.security_analysis[category];
                if (!Array.isArray(promptData) && promptData.devices) {
                    const results = await Promise.all(
                        promptData.devices.map(async (deviceId: string) => {
                            const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${deviceId}`;
                            return this.cameraAnalysisService.analyzeSingleCamera(
                                deviceId,
                                {
                                    success: true,
                                    snapshot_url: snapshotUrl,
                                    snapshot_base64: await getBase64Snapshot(snapshotUrl, deviceId)
                                },
                                `${this.env.HASSIO_URL}/api/camera_proxy_stream/${deviceId}`,
                                'security_analysis'
                            );
                        })
                    );

                    // Update patrol result for this category
                    const categoryResult = this.processAnalysisResults(results);
                    const categoryStatus = categoryResult.alerts.length > 0 ? 'warning' : 'secure';
                    const categoryKey = category as keyof Omit<SecurityPatrolResult, 'timestamp' | 'overall_security_status' | 'alerts'>;

                    if (categoryKey in patrolResult) {
                        patrolResult[categoryKey] = {
                            status: categoryStatus,
                            details: categoryResult.details,
                            alerts: categoryResult.alerts
                        };
                    }

                    // Add any alerts to the overall list
                    patrolResult.alerts.push(...categoryResult.alerts);
                }
            }

            // Determine overall security status
            patrolResult.overall_security_status = patrolResult.alerts.length > 0
                ? patrolResult.alerts.some(alert => alert.includes('CRITICAL')) ? 'alert' : 'warning'
                : 'secure';

            return patrolResult;
        } catch (error) {
            console.error('Security patrol error:', error);
            throw new Error('Failed to complete security patrol');
        }
    }

    /**
     * Processes analysis results from multiple cameras in a category
     * @param results - Array of camera analysis results
     * @returns Processed results with details and alerts
     */
    private processAnalysisResults(results: CameraAnalysisResult[]): {
        details: string;
        alerts: string[];
    } {
        const alerts: string[] = [];
        const details: string[] = [];

        for (const result of results) {
            const description = result.description.trim();
            details.push(`${result.camera_id}: ${description}`);

            // Extract alerts from the description
            if (description.toLowerCase().includes('alert') ||
                description.toLowerCase().includes('warning') ||
                description.toLowerCase().includes('suspicious')) {
                alerts.push(`${result.camera_id}: ${description}`);
            }
        }

        return {
            details: details.join('\n'),
            alerts
        };
    }

    /**
     * Main request handler for security-related endpoints
     * @param request - Incoming HTTP request
     * @returns HTTP response
     */
    async handleRequest(request: Request): Promise<Response> {
        try {
            const url = new URL(request.url);
            const path = url.pathname;

            // Handle camera proxy requests
            if (path.startsWith('/api/camera_proxy/') ||
                path.startsWith('/api/camera_proxy_stream/')) {
                return proxyToHomeAssistant(request, this.env);
            }

            // Handle security patrol request
            if (path === '/api/security/patrol') {
                const patrolResults = await this.performSecurityPatrol();
                return new Response(JSON.stringify(patrolResults), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle single camera analysis
            if (path.startsWith('/api/security/analyze/camera/')) {
                const cameraId = path.split('/').pop();
                if (!cameraId) {
                    throw new Error('Camera ID is required');
                }

                const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${cameraId}`;
                const result = await this.cameraAnalysisService.analyzeSingleCamera(
                    cameraId,
                    {
                        success: true,
                        snapshot_url: snapshotUrl,
                        snapshot_base64: await getBase64Snapshot(snapshotUrl, cameraId)
                    },
                    `${this.env.HASSIO_URL}/api/camera_proxy_stream/${cameraId}`,
                    'security_analysis'
                );

                return new Response(JSON.stringify(result), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle group analysis
            if (path.startsWith('/api/security/analyze/group/')) {
                const group = path.split('/').pop();
                if (!group) {
                    throw new Error('Group name is required');
                }

                const results = await this.cameraAnalysisService.analyzeCamerasByGroup(
                    group,
                    'security_analysis'
                );

                return new Response(JSON.stringify(results), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle zone analysis
            if (path.startsWith('/api/security/analyze/zone/')) {
                const zone = path.split('/').pop();
                if (!zone) {
                    throw new Error('Zone name is required');
                }

                const results = await this.cameraAnalysisService.analyzeCamerasByUseCase(
                    zone,
                    'security_analysis'
                );

                return new Response(JSON.stringify(results), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle security scan requests
            if (path === '/api/chat/security/scan') {
                const messages = await request.json() as { camera_id: string };
                if (!messages.camera_id) {
                    throw new Error('Camera ID is required');
                }

                const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${messages.camera_id}`;
                const response = await this.cameraAnalysisService.analyzeSingleCamera(
                    messages.camera_id,
                    {
                        success: true,
                        snapshot_url: snapshotUrl,
                        snapshot_base64: await getBase64Snapshot(snapshotUrl, messages.camera_id)
                    },
                    `${this.env.HASSIO_URL}/api/camera_proxy_stream/${messages.camera_id}`,
                    'security_analysis'
                );
                return new Response(JSON.stringify(response), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not Found', { status: 404 });
        } catch (error: unknown) {
            console.error('Security worker error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const errorCause = error instanceof Error ? error.cause : 'Security worker error';

            return new Response(JSON.stringify({
                error: errorMessage,
                details: errorCause
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}
```

# File: ./services/hassio.service.ts

```typescript
import { EntityStateUpdate, Env, HomeAssistantDeviceState, HomeAssistantProxy, IntentData } from '../types';
import { getCameraInfo } from '../utils/camera';

export class HassioApiService {
    private homeAssistantProxy: HomeAssistantProxy;

    constructor(homeAssistantProxy: HomeAssistantProxy) {
        this.homeAssistantProxy = homeAssistantProxy;
    }

    /**
     * Helper method to handle API requests with error handling, timeouts, and retries
     */
    private async handleRequest(request: Request, env: Env, retries = 3): Promise<Response> {
        const timeout = 30000; // 30 seconds timeout
        console.log(`Handling API request: ${request.method} ${request.url}`);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await Promise.race([
                    this.homeAssistantProxy.proxyToHomeAssistant(request, env),
                    new Promise<Response>((_, reject) =>
                        setTimeout(() => reject(new Error('Request timeout')), timeout)
                    )
                ]);

                // For non-ok responses, we want to pass through the error response
                if (!response.ok) {
                    const errorResponse = await response.clone();
                    try {
                        const errorData = await errorResponse.json();
                        return new Response(JSON.stringify({
                            success: false,
                            error: errorData || 'Home Assistant request failed',
                            status: response.status,
                            details: errorData
                        }), {
                            status: response.status,
                            headers: {
                                'Content-Type': 'application/json',
                                'Cache-Control': 'no-store'
                            }
                        });
                    } catch {
                        // If we can't parse the error response, return the original
                        return response;
                    }
                }

                return response;
            } catch (error) {
                const isLastAttempt = attempt === retries;
                const isTimeout = error instanceof Error && error.message === 'Request timeout';

                console.error(`Home Assistant API error (attempt ${attempt}/${retries}):`, error);

                if (isLastAttempt) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            error: isTimeout ? "Request timed out" : "Request failed",
                            details: error instanceof Error ? error.message : String(error),
                            attempt: attempt
                        }),
                        {
                            status: isTimeout ? 504 : 502,
                            headers: {
                                "Content-Type": "application/json",
                                "Cache-Control": "no-store",
                                "X-Retry-Attempts": attempt.toString()
                            }
                        }
                    );
                }

                // Exponential backoff before retry
                await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 5000)));
            }
        }

        // This should never be reached due to the return in the last retry attempt
        throw new Error('Unreachable code');
    }

    // Basic API methods
    async getApiStatus(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getConfig(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/config`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getEvents(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/events`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getServices(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/services`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getHistory(env: Env, timestamp?: string): Promise<Response> {
        const endpoint = timestamp ? `/api/history/period/${timestamp}` : '/api/history/period';
        const request = new Request(`${env.HASSIO_URL}${endpoint}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getLogbook(env: Env, timestamp?: string): Promise<Response> {
        const endpoint = timestamp ? `/api/logbook/${timestamp}` : '/api/logbook';
        const request = new Request(`${env.HASSIO_URL}${endpoint}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getStates(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/states`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    async getEntityState(env: Env, entityId: string): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/states/${entityId}`, { method: 'GET' });
        return this.handleRequest(request, env);
    }

    // State updates
    async postEntityState(env: Env, entityId: string, state: string, attributes?: Record<string, any>): Promise<Response> {
        if (!entityId || !state) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Entity ID and state are required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const stateUpdate: EntityStateUpdate = {
            state,
            attributes: attributes || {}
        };

        const request = new Request(`${env.HASSIO_URL}/api/states/${entityId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stateUpdate)
        });

        return this.handleRequest(request, env);
    }

    // Event handling
    async postEvent(env: Env, eventType: string, eventData?: Record<string, any>): Promise<Response> {
        if (!eventType) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Event type is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/events/${eventType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData || {})
        });

        return this.handleRequest(request, env);
    }

    // Service calls
    async postServiceCall(env: Env, domain: string, service: string, serviceData?: Record<string, any>): Promise<Response> {
        if (!domain || !service) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Domain and service are required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(serviceData || {})
        });

        return this.handleRequest(request, env);
    }

    // Template rendering
    async postTemplate(env: Env, template: string): Promise<Response> {
        if (!template) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Template string is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/template`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template })
        });

        return this.handleRequest(request, env);
    }

    // Configuration validation
    async postCheckConfig(env: Env): Promise<Response> {
        const request = new Request(`${env.HASSIO_URL}/api/config/core/check_config`, {
            method: 'POST'
        });

        return this.handleRequest(request, env);
    }

    // Intent handling
    async postHandleIntent(env: Env, intentData: IntentData): Promise<Response> {
        if (!intentData.name) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Invalid parameters",
                    details: "Intent name is required"
                }),
                {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const request = new Request(`${env.HASSIO_URL}/api/intent/handle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intentData)
        });

        return this.handleRequest(request, env);
    }

    // Direct proxy method
    async proxyToHomeAssistant(request: Request, env: Env): Promise<Response> {
        // Instead of creating circular reference, use handleRequest directly
        return this.handleRequest(request, env);
    }
}```

# File: ./services/openapi.service.ts

```typescript
/**
 * @fileoverview OpenAPI specification service for custom GPT integration
 * Generates and maintains OpenAPI documentation that can be consumed by GPT models
 */

import { OpenAPISpec, OpenAPIPath } from '../types';

export class OpenAPIService {
    /**
     * Generates complete OpenAPI specification for the worker
     * @returns OpenAPI specification object
     */
    generateSpec(): OpenAPISpec {
        return {
            openapi: '3.0.0',
            info: {
                title: 'Home Assistant Worker API',
                version: '1.0.0',
                description: 'API for interacting with Home Assistant through Cloudflare Worker'
            },
            servers: [
                {
                    url: 'https://hassio-api.workers.dev',
                    description: 'Production API'
                }
            ],
            security: [
                { ApiKeyAuth: [] },
                { BearerAuth: [] }
            ],
            components: {
                securitySchemes: {
                    ApiKeyAuth: {
                        type: 'apiKey',
                        in: 'header',
                        name: 'X-Api-Key',
                        description: 'API key for worker-specific endpoints'
                    },
                    BearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                        description: 'Bearer token for Home Assistant endpoints'
                    }
                },
                schemas: {
                    WebSocketMessage: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: ['subscribe', 'unsubscribe', 'ping', 'pong']
                            },
                            entities: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of entity IDs for subscription'
                            }
                        }
                    },
                    CameraAnalysisResult: {
                        type: 'object',
                        properties: {
                            camera_id: { type: 'string' },
                            description: { type: 'string' },
                            snapshot_url: { type: 'string' },
                            stream_url: { type: 'string' },
                            snapshot_base64: { type: 'string' },
                            timestamp: { type: 'string' },
                            metadata: {
                                type: 'object',
                                properties: {
                                    location: { type: 'string' },
                                    floor: { type: 'string' },
                                    group: { type: 'string' },
                                    key_zones: {
                                        type: 'array',
                                        items: { type: 'string' }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            paths: {
                '/api/websocket': {
                    get: {
                        summary: 'Establish WebSocket connection for real-time updates',
                        description: 'Upgrades the connection to WebSocket for receiving real-time entity state updates. Limited to 100 concurrent clients with 30-second ping interval.',
                        responses: {
                            '101': {
                                description: 'WebSocket connection established successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/WebSocketMessage'
                                        }
                                    }
                                }
                            },
                            '503': {
                                description: 'Too many connections (max 100 clients)'
                            }
                        }
                    }
                },
                '/api/states/{entity_id}': {
                    get: {
                        summary: 'Get state of an entity',
                        parameters: [
                            {
                                name: 'entity_id',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Entity ID (e.g., light.living_room)'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Entity state retrieved successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                entity_id: { type: 'string' },
                                                state: { type: 'string' },
                                                attributes: { type: 'object' },
                                                last_changed: { type: 'string' },
                                                last_updated: { type: 'string' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    post: {
                        summary: 'Update state of an entity',
                        parameters: [
                            {
                                name: 'entity_id',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Entity ID to update'
                            }
                        ],
                        requestBody: {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            state: { type: 'string' },
                                            attributes: { type: 'object' }
                                        },
                                        required: ['state']
                                    }
                                }
                            }
                        },
                        responses: {
                            '200': {
                                description: 'Entity state updated successfully'
                            }
                        }
                    }
                },
                '/api/services/{domain}/{service}': {
                    post: {
                        summary: 'Call a Home Assistant service',
                        parameters: [
                            {
                                name: 'domain',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Service domain (e.g., light, switch)'
                            },
                            {
                                name: 'service',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Service name (e.g., turn_on, turn_off)'
                            }
                        ],
                        requestBody: {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            entity_id: { type: 'string' },
                                            service_data: { type: 'object' }
                                        }
                                    }
                                }
                            }
                        },
                        responses: {
                            '200': {
                                description: 'Service called successfully'
                            }
                        }
                    }
                },
                '/api/camera/analyze': {
                    get: {
                        summary: 'Analyze camera feed(s)',
                        parameters: [
                            {
                                name: 'camera_id',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Optional camera ID to analyze. If not provided, analyzes all cameras.'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/CameraAnalysisResult'
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '/api/camera/analyze/group/{group}': {
                    get: {
                        summary: 'Analyze cameras in a specific group',
                        parameters: [
                            {
                                name: 'group',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Camera group to analyze (e.g., garage, entrance)'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Group camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/CameraAnalysisResult'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '/api/camera/analyze/use-case/{use_case}': {
                    get: {
                        summary: 'Analyze cameras for a specific use case',
                        parameters: [
                            {
                                name: 'use_case',
                                in: 'path',
                                required: true,
                                schema: {
                                    type: 'string'
                                },
                                description: 'Use case to filter cameras (e.g., security_monitoring, pet_monitoring)'
                            },
                            {
                                name: 'prompt_class',
                                in: 'query',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['security_analysis', 'maintenance', 'general']
                                },
                                description: 'Type of analysis to perform'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Use case camera analysis completed successfully',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/CameraAnalysisResult'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }

    /**
     * Endpoint handler for serving OpenAPI spec
     * @param request - Incoming HTTP request
     * @returns Response with OpenAPI specification
     */
    async handleRequest(request: Request): Promise<Response> {
        try {
            const spec = this.generateSpec();
            return new Response(JSON.stringify(spec, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'max-age=3600'
                }
            });
        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Failed to generate OpenAPI specification',
                details: error
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    /**
     * Updates paths in the OpenAPI specification
     * @param newPaths - New path definitions to add/update
     * @returns Updated OpenAPI specification
     */
    updatePaths(newPaths: Record<string, Record<string, OpenAPIPath>>): OpenAPISpec {
        const spec = this.generateSpec();
        spec.paths = {
            ...spec.paths,
            ...newPaths
        };
        return spec;
    }
}
```

