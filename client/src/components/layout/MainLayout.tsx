import React, { useState } from 'react';
import { useMobileSidebar, MobileSidebarOverlay } from './MobileSidebar';
import { useMobile } from '../../hooks/useMobile';
import { X } from 'lucide-react';
import SetupBanner from './SetupBanner';

interface Props {
  sidebar: React.ReactNode;
  header: React.ReactNode;
  children: React.ReactNode;
  rightPanel?: React.ReactNode;
}

export default function MainLayout({ sidebar, header, children, rightPanel }: Props) {
  const { sidebarOpen } = useMobileSidebar();
  const isMobile = useMobile();
  const [mobileRightPanelOpen, setMobileRightPanelOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0d1117]">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        {sidebar}
      </div>

      {/* Mobile sidebar overlay */}
      <MobileSidebarOverlay />
      <div
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {header}
        <SetupBanner />
        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 overflow-hidden">{children}</main>
          {/* Desktop right panel */}
          {rightPanel && (
            <aside className="hidden md:block w-80 border-l border-gray-800/50 bg-[#0d1117] overflow-y-auto">
              {rightPanel}
            </aside>
          )}
          {/* Mobile right panel - full screen overlay */}
          {rightPanel && isMobile && mobileRightPanelOpen && (
            <div className="fixed inset-0 z-40 bg-[#0d1117] flex flex-col md:hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800/50">
                <span className="text-sm font-medium text-gray-300">Panel</span>
                <button
                  onClick={() => setMobileRightPanelOpen(false)}
                  className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {rightPanel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
