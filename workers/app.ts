import { createRequestHandler } from "react-router";

// AI Agent SDK components
class HomeAssistantAgent {
  private state: AgentState;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.state = {
      conversation: {
        recentEntities: [],
        currentContext: {},
        pendingConfirmations: [],
        messages: []
      },
      user: {
        preferences: {},
        favoriteDevices: []
      },
      session: {
        authenticated: true,
        lastActivity: Date.now(),
        permissions: ['read', 'write', 'control']
      }
    };
  }

  setState(newState: AgentState) {
    this.state = newState;
  }

  async processMessage(message: string) {
    // Process user message with AI
    try {
      // Use env.AI directly as provided by Cloudflare Workers
      const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          ...this.state.conversation.messages,
          { role: 'user', content: message }
        ]
      });
      
      // Check if response is a ReadableStream (streaming response) or has response property
      const responseText = typeof response === 'object' && 'response' in response
        ? response.response as string
        : 'No response generated';
      
      // Update state
      this.setState({
        ...this.state,
        conversation: {
          ...this.state.conversation,
          messages: [
            ...this.state.conversation.messages,
            { role: 'user', content: message },
            { role: 'assistant', content: responseText }
          ],
          lastActivity: Date.now()
        }
      });
      
      return { response: responseText };
    } catch (error) {
      console.error('Error processing message:', error);
      return { response: "I'm sorry, I encountered an error processing your request." };
    }
  }
  
  getSystemPrompt() {
    return `You are a helpful assistant that controls a Home Assistant smart home system. 
      You can control devices, check status, and analyze camera feeds.
      Current context: ${JSON.stringify(this.state.conversation.currentContext)}
      Recent entities: ${JSON.stringify(this.state.conversation.recentEntities)}`;
  }
}

interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AgentState {
  conversation: {
    recentEntities: string[];
    currentContext: Record<string, any>;
    pendingConfirmations: any[];
    messages: AiMessage[];
    lastActivity?: number;
  };
  user: {
    preferences: Record<string, any>;
    favoriteDevices: string[];
  };
  session: {
    authenticated: boolean;
    lastActivity: number;
    permissions: string[];
  };
}

// Camera Metadata Store using D1 database
class CameraMetadataStore {
  private db: D1Database;
  
  constructor(db: D1Database) {
    this.db = db;
  }
  
  // Initialize the database schema if it doesn't exist
  async initializeSchema(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS camera_metadata (
        camera_id TEXT PRIMARY KEY,
        description TEXT,
        location TEXT,
        floor TEXT,
        group_name TEXT,
        key_zones TEXT,
        use_cases TEXT
      )
    `;
    
    await this.db.exec(createTableQuery);
  }
  
  // Get metadata for a specific camera
  async getCamera(cameraId: string): Promise<CameraMetadata | null> {
    const query = "SELECT * FROM camera_metadata WHERE camera_id = ?";
    const result = await this.db.prepare(query).bind(cameraId).first();
    
    if (!result) return null;
    
    return {
      camera_id: result.camera_id as string,
      description: result.description as string,
      location: result.location as string,
      floor: result.floor as string,
      group: result.group_name as string,
      key_zones: JSON.parse(result.key_zones as string || '[]'),
      use_cases: JSON.parse(result.use_cases as string || '[]')
    };
  }
  
  // Get all cameras
  async getAllCameras(): Promise<CameraMetadata[]> {
    const query = "SELECT * FROM camera_metadata";
    const result = await this.db.prepare(query).all<any>();
    
    if (!result.results.length) return [];
    
    return result.results.map((row: any) => ({
      camera_id: row.camera_id,
      description: row.description,
      location: row.location,
      floor: row.floor,
      group: row.group_name,
      key_zones: JSON.parse(row.key_zones || '[]'),
      use_cases: JSON.parse(row.use_cases || '[]')
    }));
  }
  
  // Add or update a camera
  async upsertCamera(metadata: CameraMetadata): Promise<void> {
    const query = `
      INSERT INTO camera_metadata (camera_id, description, location, floor, group_name, key_zones, use_cases)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (camera_id) DO UPDATE SET
        description = excluded.description,
        location = excluded.location,
        floor = excluded.floor,
        group_name = excluded.group_name,
        key_zones = excluded.key_zones,
        use_cases = excluded.use_cases
    `;
    
    await this.db.prepare(query).bind(
      metadata.camera_id,
      metadata.description,
      metadata.location,
      metadata.floor,
      metadata.group,
      JSON.stringify(metadata.key_zones),
      JSON.stringify(metadata.use_cases)
    ).run();
  }
  
  // Delete a camera
  async deleteCamera(cameraId: string): Promise<void> {
    const query = "DELETE FROM camera_metadata WHERE camera_id = ?";
    await this.db.prepare(query).bind(cameraId).run();
  }
  
  // Import metadata from JSON
  async importFromJSON(metadataArray: CameraMetadata[]): Promise<void> {
    // Use a transaction to ensure all inserts succeed or fail together
    await this.db.batch(metadataArray.map(metadata => {
      return this.db.prepare(`
        INSERT INTO camera_metadata (camera_id, description, location, floor, group_name, key_zones, use_cases)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (camera_id) DO UPDATE SET
          description = excluded.description,
          location = excluded.location,
          floor = excluded.floor,
          group_name = excluded.group_name,
          key_zones = excluded.key_zones,
          use_cases = excluded.use_cases
      `).bind(
        metadata.camera_id,
        metadata.description,
        metadata.location,
        metadata.floor,
        metadata.group,
        JSON.stringify(metadata.key_zones),
        JSON.stringify(metadata.use_cases)
      );
    }));
  }
  
  // Export all metadata to JSON
  async exportToJSON(): Promise<CameraMetadata[]> {
    return this.getAllCameras();
  }
}

// Camera metadata interface
interface CameraMetadata {
  camera_id: string;
  description: string;
  location: string;
  floor: string;
  group: string;
  key_zones: string[];
  use_cases: string[];
}

// Vision Analysis Component
class CameraAnalysisService {
  private env: Env;
  private metadataStore: CameraMetadataStore;
  
  constructor(env: Env) {
    this.env = env;
    this.metadataStore = new CameraMetadataStore(env.DB);
  }
  
  async initializeDatabase(): Promise<void> {
    await this.metadataStore.initializeSchema();
  }
  
  async analyzeSingleCamera(cameraId: string, promptType: string = 'general_status') {
    // Get camera metadata for enhanced context
    const metadata = await this.metadataStore.getCamera(cameraId);
    try {
      // Construct camera URLs
      const snapshotUrl = `${this.env.HASSIO_URL}/api/camera_proxy/${cameraId}`;
      const streamUrl = `${this.env.HASSIO_URL}/api/camera_proxy_stream/${cameraId}`;
      
      // Fetch snapshot
      const response = await fetch(snapshotUrl, {
        headers: {
          'Authorization': `Bearer ${this.env.HASSIO_TOKEN}`
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch camera snapshot: ${response.status}`);
      }
      
      // Convert to base64
      const arrayBuffer = await response.arrayBuffer();
      const base64 = this.arrayBufferToBase64(arrayBuffer);
      
      // Use Cloudflare AI with vision model and enhanced context from metadata
      let systemPrompt = `You are a security camera analyst focused on analyzing camera footage. Provide detailed observations about what you see.`;
      
      // Add metadata context if available
      if (metadata) {
        systemPrompt += `\n\nCamera information:
- Location: ${metadata.location}
- Description: ${metadata.description}
- Floor: ${metadata.floor}
- Group: ${metadata.group}
- Key zones to monitor: ${metadata.key_zones.join(', ')}
- Use cases: ${metadata.use_cases.join(', ')}`;
      }
      
      // Define proper vision input
      const visionInput = {
        messages: [
          { role: 'system', content: systemPrompt },
          { 
            role: 'user',
            content: [
              { 
                type: 'image', 
                image: base64 
              },
              {
                type: 'text',
                text: "Analyze this camera image and describe what you see in detail."
              }
            ] as any // Type assertion needed for complex message format
          }
        ]
      };
      
      // Use the AI instance from env
      const aiResponse = await this.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', visionInput);
      
      // Extract response text from aiResponse
      const description = typeof aiResponse === 'object' && 'response' in aiResponse
        ? aiResponse.response as string
        : 'Unable to analyze image';
      
      const result = {
        camera_id: cameraId,
        description,
        snapshot_url: snapshotUrl,
        stream_url: streamUrl,
        snapshot_base64: base64,
        timestamp: new Date().toISOString(),
        metadata: metadata || undefined
      };
      
      return result;
    } catch (error) {
      console.error(`Error analyzing camera ${cameraId}:`, error);
      throw error;
    }
  }
  
  // Helper function to convert ArrayBuffer to Base64
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(buffer);
    const binaryString = String.fromCharCode(...uint8Array);
    return btoa(binaryString);
  }
}

// Router handlers
interface ChatRequest {
  message: string;
}

async function handleChatRequest(request: Request, env: Env) {
  try {
    const agent = new HomeAssistantAgent(env);
    const { message } = await request.json() as ChatRequest;
    
    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const response = await agent.processMessage(message);
    
    return new Response(JSON.stringify({
      response: response.response,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error handling chat request:', error);
    return new Response(JSON.stringify({
      error: 'Failed to process chat request',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleCameraAnalysisRequest(request: Request, env: Env) {
  try {
    const url = new URL(request.url);
    const cameraId = url.searchParams.get('camera_id');
    
    if (!cameraId) {
      return new Response(JSON.stringify({ error: 'Camera ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const analysisService = new CameraAnalysisService(env);
    const result = await analysisService.analyzeSingleCamera(cameraId);
    
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error handling camera analysis request:', error);
    return new Response(JSON.stringify({
      error: 'Failed to analyze camera',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// React Router configuration
declare global {
  interface CloudflareEnvironment extends Env {}
}

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareEnvironment;
      ctx: ExecutionContext;
    };
  }
}

const serverBuildModule = "virtual:react-router/server-build";

// Create a function that will handle the import with error handling
async function getServerBuild() {
  try {
    // Using dynamic import for the server build module
    // We're marking this as external in the Vite config, so it will be resolved at runtime
    return import(serverBuildModule);
  } catch (error) {
    console.error("Failed to import server build:", error);
    throw error;
  }
}

const requestHandler = createRequestHandler(
  getServerBuild,
  import.meta.env.MODE,
);

// Prompt Management System
class PromptManagementSystem {
  private db: D1Database;
  
  constructor(db: D1Database) {
    this.db = db;
  }
  
  // Initialize database schema
  async initializeSchema(): Promise<void> {
    const createPromptTypesTable = `
      CREATE TABLE IF NOT EXISTS prompt_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT
      )
    `;
    
    const createPromptCategoriesTable = `
      CREATE TABLE IF NOT EXISTS prompt_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT
      )
    `;
    
    const createPromptTemplatesTable = `
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL,
        category_id TEXT,
        template_text TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY (type_id) REFERENCES prompt_types(id),
        FOREIGN KEY (category_id) REFERENCES prompt_categories(id)
      )
    `;
    
    const createDeviceAssignmentsTable = `
      CREATE TABLE IF NOT EXISTS device_assignments (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        FOREIGN KEY (category_id) REFERENCES prompt_categories(id)
      )
    `;
    
    await this.db.exec(createPromptTypesTable);
    await this.db.exec(createPromptCategoriesTable);
    await this.db.exec(createPromptTemplatesTable);
    await this.db.exec(createDeviceAssignmentsTable);
  }
  
  // Get prompt template by type and optional category
  async getPromptTemplate(typeId: string, categoryId?: string): Promise<PromptTemplate | null> {
    let query = `
      SELECT pt.id, pt.template_text, pt.type_id, pt.category_id, 
             type.name as type_name, cat.name as category_name
      FROM prompt_templates pt
      LEFT JOIN prompt_types type ON pt.type_id = type.id
      LEFT JOIN prompt_categories cat ON pt.category_id = cat.id
      WHERE pt.type_id = ?
    `;
    
    const params = [typeId];
    
    if (categoryId) {
      query += " AND pt.category_id = ?";
      params.push(categoryId);
    }
    
    // Order by updated_at desc to get the most recent template
    query += " ORDER BY pt.updated_at DESC LIMIT 1";
    
    const result = await this.db.prepare(query).bind(...params).first();
    
    if (!result) return null;
    
    return {
      id: result.id as string,
      template: result.template_text as string,
      typeId: result.type_id as string,
      typeName: result.type_name as string,
      categoryId: result.category_id as string,
      categoryName: result.category_name as string
    };
  }
  
  // Get prompt for a specific device
  async getPromptForDevice(deviceId: string, typeId: string): Promise<PromptTemplate | null> {
    // First get the category assigned to this device
    const deviceAssignmentQuery = `
      SELECT da.category_id
      FROM device_assignments da
      WHERE da.device_id = ?
      ORDER BY da.priority DESC
      LIMIT 1
    `;
    
    const deviceCategory = await this.db.prepare(deviceAssignmentQuery).bind(deviceId).first();
    
    if (!deviceCategory) {
      // If no specific category assigned, get default prompt for this type
      return this.getPromptTemplate(typeId);
    }
    
    // Get prompt template for this type and category
    const promptTemplate = await this.getPromptTemplate(typeId, deviceCategory.category_id as string);
    
    // If no specific template exists for this category, fall back to type default
    if (!promptTemplate) {
      return this.getPromptTemplate(typeId);
    }
    
    return promptTemplate;
  }
  
  // Add or update a prompt template
  async upsertPromptTemplate(template: PromptTemplate): Promise<string> {
    const id = template.id || crypto.randomUUID();
    const now = Date.now();
    
    const query = `
      INSERT INTO prompt_templates (id, type_id, category_id, template_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        type_id = excluded.type_id,
        category_id = excluded.category_id,
        template_text = excluded.template_text,
        updated_at = excluded.updated_at
    `;
    
    await this.db.prepare(query).bind(
      id,
      template.typeId,
      template.categoryId,
      template.template,
      now,
      now
    ).run();
    
    return id;
  }
  
  // Delete a prompt template
  async deletePromptTemplate(id: string): Promise<void> {
    const query = "DELETE FROM prompt_templates WHERE id = ?";
    await this.db.prepare(query).bind(id).run();
  }
  
  // Assign a category to a device
  async assignCategoryToDevice(deviceId: string, categoryId: string, priority: number = 0): Promise<void> {
    const query = `
      INSERT INTO device_assignments (id, device_id, category_id, priority)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        category_id = excluded.category_id,
        priority = excluded.priority
    `;
    
    await this.db.prepare(query).bind(
      crypto.randomUUID(),
      deviceId,
      categoryId,
      priority
    ).run();
  }
  
  // List all prompt types
  async listPromptTypes(): Promise<PromptType[]> {
    const query = "SELECT * FROM prompt_types";
    const result = await this.db.prepare(query).all();
    
    return (result.results || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description
    }));
  }
  
  // List all prompt categories
  async listPromptCategories(): Promise<PromptCategory[]> {
    const query = "SELECT * FROM prompt_categories";
    const result = await this.db.prepare(query).all();
    
    return (result.results || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description
    }));
  }
}

interface PromptType {
  id: string;
  name: string;
  description: string;
}

interface PromptCategory {
  id: string;
  name: string;
  description: string;
}

interface PromptTemplate {
  id?: string;
  template: string;
  typeId: string;
  typeName?: string;
  categoryId?: string;
  categoryName?: string;
}

// WebSocket handler for real-time updates
class WebSocketHandler {
  private clients: Map<string, WebSocket> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map(); // entity -> client IDs
  private env: Env;
  
  constructor(env: Env) {
    this.env = env;
  }
  
  // Handle a new WebSocket connection
  handleConnection(request: Request, env: Env): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    
    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];
    
    // Generate a unique ID for this client
    const clientId = crypto.randomUUID();
    
    // Store the client
    this.clients.set(clientId, server);
    
    // Setup event handlers
    server.accept();
    
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);
        
        switch (message.type) {
          case 'subscribe':
            this.handleSubscribe(clientId, message.entities);
            break;
          case 'unsubscribe':
            this.handleUnsubscribe(clientId, message.entities);
            break;
          case 'ping':
            server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
          default:
            server.send(JSON.stringify({
              type: 'error',
              message: `Unknown message type: ${message.type}`
            }));
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        server.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format'
        }));
      }
    });
    
    server.addEventListener('close', () => {
      // Remove client from all subscriptions
      this.clients.delete(clientId);
      
      for (const [entity, clients] of this.subscriptions.entries()) {
        clients.delete(clientId);
        if (clients.size === 0) {
          this.subscriptions.delete(entity);
        }
      }
    });
    
    // Send welcome message
    server.send(JSON.stringify({
      type: 'welcome',
      clientId,
      timestamp: Date.now()
    }));
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  
  // Handle entity subscription
  private handleSubscribe(clientId: string, entities: string[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    for (const entity of entities) {
      if (!this.subscriptions.has(entity)) {
        this.subscriptions.set(entity, new Set());
      }
      this.subscriptions.get(entity)!.add(clientId);
    }
    
    client.send(JSON.stringify({
      type: 'subscribed',
      entities,
      timestamp: Date.now()
    }));
  }
  
  // Handle entity unsubscription
  private handleUnsubscribe(clientId: string, entities: string[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    for (const entity of entities) {
      const subscribers = this.subscriptions.get(entity);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          this.subscriptions.delete(entity);
        }
      }
    }
    
    client.send(JSON.stringify({
      type: 'unsubscribed',
      entities,
      timestamp: Date.now()
    }));
  }
  
  // Publish entity update to all subscribers
  publishUpdate(entity: string, data: any): void {
    const subscribers = this.subscriptions.get(entity);
    if (!subscribers) return;
    
    const update = JSON.stringify({
      type: 'update',
      entity,
      data,
      timestamp: Date.now()
    });
    
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(update);
      }
    }
  }
}

// Add camera metadata API handlers
async function handleCameraMetadataRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cameraId = url.pathname.split('/').pop();
  const metadataStore = new CameraMetadataStore(env.DB);
  
  // Initialize schema if needed
  await metadataStore.initializeSchema();
  
  switch (request.method) {
    case 'GET': {
      if (cameraId) {
        // Get single camera
        const camera = await metadataStore.getCamera(cameraId);
        if (!camera) {
          return new Response(JSON.stringify({ error: 'Camera not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify(camera), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // List all cameras
        const cameras = await metadataStore.getAllCameras();
        return new Response(JSON.stringify(cameras), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    case 'POST': {
      // Create or update camera
      const metadata = await request.json() as CameraMetadata;
      
      if (!metadata.camera_id) {
        return new Response(JSON.stringify({ error: 'camera_id is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await metadataStore.upsertCamera(metadata);
      
      return new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    case 'DELETE': {
      if (!cameraId) {
        return new Response(JSON.stringify({ error: 'camera_id is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await metadataStore.deleteCamera(cameraId);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    default:
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
  }
}

// Handle prompt API requests
async function handlePromptRequest(request: Request, env: Env): Promise<Response> {
  const promptManager = new PromptManagementSystem(env.DB);
  
  // Initialize schema if needed
  await promptManager.initializeSchema();
  
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  
  // /api/prompts/types
  if (path[2] === 'types') {
    const types = await promptManager.listPromptTypes();
    return new Response(JSON.stringify(types), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // /api/prompts/categories
  if (path[2] === 'categories') {
    const categories = await promptManager.listPromptCategories();
    return new Response(JSON.stringify(categories), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // /api/prompts/templates
  if (path[2] === 'templates') {
    if (request.method === 'GET') {
      const typeId = url.searchParams.get('type');
      const categoryId = url.searchParams.get('category');
      
      if (!typeId) {
        return new Response(JSON.stringify({ error: 'type parameter is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const template = await promptManager.getPromptTemplate(typeId, categoryId || undefined);
      
      if (!template) {
        return new Response(JSON.stringify({ error: 'Template not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify(template), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST') {
      const template = await request.json() as PromptTemplate;
      
      if (!template.typeId || !template.template) {
        return new Response(JSON.stringify({ error: 'typeId and template are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const id = await promptManager.upsertPromptTemplate(template);
      
      return new Response(JSON.stringify({ id, success: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'DELETE') {
      const id = path[3];
      
      if (!id) {
        return new Response(JSON.stringify({ error: 'Template ID is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await promptManager.deletePromptTemplate(id);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // /api/prompts/device-assignments
  if (path[2] === 'device-assignments' && request.method === 'POST') {
    const { deviceId, categoryId, priority } = await request.json() as any;
    
    if (!deviceId || !categoryId) {
      return new Response(JSON.stringify({ error: 'deviceId and categoryId are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    await promptManager.assignCategoryToDevice(deviceId, categoryId, priority || 0);
    
    return new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}

// WebSocket connection instance
let wsHandler: WebSocketHandler | null = null;

// Main worker export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // Initialize WebSocket handler if not created
    if (!wsHandler) {
      wsHandler = new WebSocketHandler(env);
    }
    
    // WebSocket connection
    if (url.pathname === '/api/ws') {
      return wsHandler.handleConnection(request, env);
    }
    
    // API endpoints for chat and camera analysis
    if (url.pathname === '/api/chat') {
      return handleChatRequest(request, env);
    }
    
    if (url.pathname === '/api/camera/analyze') {
      return handleCameraAnalysisRequest(request, env);
    }
    
    // Camera metadata API
    if (url.pathname.startsWith('/api/cameras')) {
      return handleCameraMetadataRequest(request, env);
    }
    
    // Prompt management API
    if (url.pathname.startsWith('/api/prompts')) {
      return handlePromptRequest(request, env);
    }
    
    // Default to React Router for UI
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<CloudflareEnvironment>;
