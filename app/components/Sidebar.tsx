import React from 'react';

interface SidebarProps {
  activePage: 'chat' | 'cameras' | 'settings';
  setActivePage: React.Dispatch<React.SetStateAction<'chat' | 'cameras' | 'settings'>>;
}

export function Sidebar({ activePage, setActivePage }: SidebarProps) {
  return (
    <aside className="w-64 bg-indigo-900 text-white flex flex-col">
      <div className="p-4">
        <h1 className="text-xl font-bold">Home Assistant</h1>
        <p className="text-sm text-indigo-200">Smart Home Control</p>
      </div>
      
      <nav className="flex-1 px-2 py-4 space-y-1">
        <button
          onClick={() => setActivePage('chat')}
          className={`w-full flex items-center px-4 py-2 rounded-md ${
            activePage === 'chat' 
              ? 'bg-indigo-800 text-white' 
              : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
          }`}
        >
          <svg className="mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          Chat Assistant
        </button>
        
        <button
          onClick={() => setActivePage('cameras')}
          className={`w-full flex items-center px-4 py-2 rounded-md ${
            activePage === 'cameras' 
              ? 'bg-indigo-800 text-white' 
              : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
          }`}
        >
          <svg className="mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
          </svg>
          Cameras
        </button>
        
        <button
          onClick={() => setActivePage('settings')}
          className={`w-full flex items-center px-4 py-2 rounded-md ${
            activePage === 'settings' 
              ? 'bg-indigo-800 text-white' 
              : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
          }`}
        >
          <svg className="mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Settings
        </button>
      </nav>
      
      <div className="p-4 border-t border-indigo-800">
        <div className="flex items-center space-x-3">
          <div className="h-8 w-8 rounded-full bg-indigo-500 flex items-center justify-center">
            <span className="text-sm font-medium">HA</span>
          </div>
          <div>
            <p className="text-sm font-medium">Home Assistant</p>
            <p className="text-xs text-indigo-300">Connected</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
