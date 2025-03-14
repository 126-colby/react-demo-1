import { useState, useEffect } from "react";
import type { Route } from "./+types/assistant";
import { ChatInterface } from "../components/ChatInterface";
import { CameraViewer } from "../components/CameraViewer";
import { Sidebar } from "../components/Sidebar";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Home Assistant Chatbot" },
    { name: "description", content: "Smart Home Control via Natural Language" },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  return { 
    hassioUrl: context.cloudflare.env.HASSIO_URL,
  };
}

export default function Assistant({ loaderData }: Route.ComponentProps) {
  const [activePage, setActivePage] = useState<'chat' | 'cameras' | 'settings'>('chat');
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  
  // Fetch camera metadata when the component mounts
  useEffect(() => {
    async function fetchCameras() {
      try {
        const response = await fetch('/api/cameras');
        if (response.ok) {
          const cameraData = await response.json();
          setCameras(cameraData);
          if (cameraData.length > 0) {
            setSelectedCamera(cameraData[0].camera_id);
          }
        } else {
          console.error('Failed to fetch cameras');
        }
      } catch (error) {
        console.error('Error fetching cameras:', error);
      }
    }
    
    fetchCameras();
  }, []);
  
  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      <Sidebar 
        activePage={activePage} 
        setActivePage={setActivePage} 
      />
      
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white shadow-sm p-4 flex justify-between items-center">
          <h1 className="text-xl font-semibold">
            {activePage === 'chat' && 'Chat Assistant'}
            {activePage === 'cameras' && 'Security Cameras'}
            {activePage === 'settings' && 'Settings'}
          </h1>
        </header>
        
        <div className="flex-1 overflow-auto p-4">
          {activePage === 'chat' && (
            <ChatInterface />
          )}
          
          {activePage === 'cameras' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-lg shadow-sm p-4">
                <h2 className="text-lg font-medium mb-4">Camera Feed</h2>
                {selectedCamera ? (
                  <CameraViewer 
                    cameraId={selectedCamera} 
                    hassioUrl={loaderData.hassioUrl}
                  />
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    No camera selected
                  </div>
                )}
              </div>
              <div className="bg-white rounded-lg shadow-sm p-4">
                <h2 className="text-lg font-medium mb-4">Camera List</h2>
                {cameras.length > 0 ? (
                  <ul className="divide-y">
                    {cameras.map(camera => (
                      <li 
                        key={camera.camera_id}
                        className={`py-2 px-3 cursor-pointer rounded ${selectedCamera === camera.camera_id ? 'bg-blue-100' : 'hover:bg-gray-100'}`}
                        onClick={() => setSelectedCamera(camera.camera_id)}
                      >
                        <div className="font-medium">{camera.description || camera.camera_id}</div>
                        <div className="text-sm text-gray-500">{camera.location}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    No cameras configured
                  </div>
                )}
              </div>
            </div>
          )}
          
          {activePage === 'settings' && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <h2 className="text-lg font-medium mb-4">Camera Management</h2>
              <CameraMetadataManager 
                cameras={cameras} 
                setCameras={setCameras} 
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function CameraMetadataManager({ 
  cameras, 
  setCameras 
}: { 
  cameras: any[]; 
  setCameras: React.Dispatch<React.SetStateAction<any[]>>;
}) {
  const [editingCamera, setEditingCamera] = useState<any>(null);
  const [formData, setFormData] = useState({
    camera_id: '',
    description: '',
    location: '',
    floor: '',
    group: '',
    key_zones: '',
    use_cases: ''
  });
  
  const handleEditCamera = (camera: any) => {
    setEditingCamera(camera);
    setFormData({
      ...camera,
      key_zones: camera.key_zones.join(', '),
      use_cases: camera.use_cases.join(', ')
    });
  };
  
  const handleNewCamera = () => {
    setEditingCamera({});
    setFormData({
      camera_id: '',
      description: '',
      location: '',
      floor: '',
      group: '',
      key_zones: '',
      use_cases: ''
    });
  };
  
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const cameraData = {
      ...formData,
      key_zones: formData.key_zones.split(',').map(zone => zone.trim()).filter(Boolean),
      use_cases: formData.use_cases.split(',').map(use => use.trim()).filter(Boolean)
    };
    
    try {
      const response = await fetch('/api/cameras', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cameraData),
      });
      
      if (response.ok) {
        // Refresh the camera list
        const getCamerasResponse = await fetch('/api/cameras');
        if (getCamerasResponse.ok) {
          const updatedCameras = await getCamerasResponse.json();
          setCameras(updatedCameras);
        }
        
        setEditingCamera(null);
      } else {
        console.error('Failed to save camera');
      }
    } catch (error) {
      console.error('Error saving camera:', error);
    }
  };
  
  const handleDelete = async (cameraId: string) => {
    if (!confirm('Are you sure you want to delete this camera?')) return;
    
    try {
      const response = await fetch(`/api/cameras/${cameraId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        setCameras(cameras.filter(camera => camera.camera_id !== cameraId));
      } else {
        console.error('Failed to delete camera');
      }
    } catch (error) {
      console.error('Error deleting camera:', error);
    }
  };
  
  return (
    <div>
      {editingCamera ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Camera ID</label>
            <input
              type="text"
              name="camera_id"
              value={formData.camera_id}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              required
              disabled={Boolean(editingCamera.camera_id)}
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Description</label>
            <input
              type="text"
              name="description"
              value={formData.description}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Location</label>
            <input
              type="text"
              name="location"
              value={formData.location}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Floor</label>
            <input
              type="text"
              name="floor"
              value={formData.floor}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Group</label>
            <input
              type="text"
              name="group"
              value={formData.group}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Key Zones (comma-separated)</label>
            <textarea
              name="key_zones"
              value={formData.key_zones}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              rows={2}
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">Use Cases (comma-separated)</label>
            <textarea
              name="use_cases"
              value={formData.use_cases}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              rows={2}
            />
          </div>
          
          <div className="flex space-x-2">
            <button
              type="submit"
              className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingCamera(null)}
              className="bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button
            onClick={handleNewCamera}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded mb-4"
          >
            Add New Camera
          </button>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Camera ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {cameras.map(camera => (
                  <tr key={camera.camera_id}>
                    <td className="px-6 py-4 whitespace-nowrap">{camera.camera_id}</td>
                    <td className="px-6 py-4 whitespace-nowrap">{camera.description}</td>
                    <td className="px-6 py-4 whitespace-nowrap">{camera.location}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button
                        onClick={() => handleEditCamera(camera)}
                        className="text-indigo-600 hover:text-indigo-900 mr-2"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(camera.camera_id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {cameras.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-4 text-center text-gray-500">
                      No cameras configured
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
