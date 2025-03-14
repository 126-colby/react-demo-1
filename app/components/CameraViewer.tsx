import React, { useState, useEffect } from 'react';

interface CameraViewerProps {
  cameraId: string;
  hassioUrl: string;
}

interface CameraAnalysisResult {
  camera_id: string;
  description: string;
  snapshot_url: string;
  stream_url: string;
  snapshot_base64: string;
  timestamp: string;
  metadata?: {
    camera_id: string;
    description: string;
    location: string;
    floor: string;
    group: string;
    key_zones: string[];
    use_cases: string[];
  };
}

export function CameraViewer({ cameraId, hassioUrl }: CameraViewerProps) {
  const [analysis, setAnalysis] = useState<CameraAnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'live' | 'snapshot'>('snapshot');
  
  useEffect(() => {
    async function analyzeCameraImage() {
      setIsLoading(true);
      setError(null);
      
      try {
        const response = await fetch(`/api/camera/analyze?camera_id=${encodeURIComponent(cameraId)}`);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch camera analysis: ${response.status}`);
        }
        
        const data = await response.json() as CameraAnalysisResult;
        setAnalysis(data);
      } catch (err) {
        console.error('Error analyzing camera image:', err);
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setIsLoading(false);
      }
    }
    
    if (cameraId) {
      analyzeCameraImage();
    }
  }, [cameraId]);
  
  const handleRefresh = () => {
    // Reset and re-fetch camera analysis
    setAnalysis(null);
    setIsLoading(true);
    setError(null);
    
    fetch(`/api/camera/analyze?camera_id=${encodeURIComponent(cameraId)}`)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch camera analysis: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setAnalysis(data as CameraAnalysisResult);
      })
      .catch(err => {
        console.error('Error analyzing camera image:', err);
        setError(err instanceof Error ? err.message : 'An error occurred');
      })
      .finally(() => {
        setIsLoading(false);
      });
  };
  
  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex space-x-2">
          <button
            onClick={() => setViewMode('snapshot')}
            className={`px-3 py-1 text-sm rounded ${
              viewMode === 'snapshot' 
                ? 'bg-indigo-600 text-white' 
                : 'bg-gray-200 text-gray-800'
            }`}
          >
            Snapshot
          </button>
          <button
            onClick={() => setViewMode('live')}
            className={`px-3 py-1 text-sm rounded ${
              viewMode === 'live' 
                ? 'bg-indigo-600 text-white' 
                : 'bg-gray-200 text-gray-800'
            }`}
          >
            Live Feed
          </button>
        </div>
        
        <button
          onClick={handleRefresh}
          className="text-indigo-600 hover:text-indigo-800"
          disabled={isLoading}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        </button>
      </div>
      
      <div className="flex-1 relative overflow-hidden rounded-lg bg-gray-900">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-50 z-10">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
          </div>
        )}
        
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-red-500 text-center p-4 bg-white bg-opacity-90 rounded-lg">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8 mx-auto mb-2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>{error}</div>
            </div>
          </div>
        )}
        
        {!isLoading && !error && analysis && (
          <>
            {viewMode === 'snapshot' && (
              <img 
                src={`data:image/jpeg;base64,${analysis.snapshot_base64}`} 
                alt={`Camera: ${analysis.metadata?.description || analysis.camera_id}`}
                className="w-full h-full object-contain"
              />
            )}
            
            {viewMode === 'live' && (
              <img 
                src={analysis.stream_url} 
                alt={`Live feed: ${analysis.metadata?.description || analysis.camera_id}`}
                className="w-full h-full object-contain"
              />
            )}
          </>
        )}
      </div>
      
      {!isLoading && !error && analysis && (
        <div className="mt-4">
          <h3 className="font-semibold text-lg">Analysis</h3>
          <p className="text-gray-700 mt-1">{analysis.description}</p>
          
          {analysis.metadata && (
            <div className="mt-3 border-t pt-3">
              <h4 className="font-medium text-sm text-gray-600">Camera Information</h4>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-gray-500">Location</dt>
                  <dd>{analysis.metadata.location}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Floor</dt>
                  <dd>{analysis.metadata.floor}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Group</dt>
                  <dd>{analysis.metadata.group}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Key Zones</dt>
                  <dd>{analysis.metadata.key_zones.join(', ')}</dd>
                </div>
              </dl>
            </div>
          )}
          
          <div className="text-xs text-gray-500 mt-3">
            Last updated: {new Date(analysis.timestamp).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
