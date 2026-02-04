import React from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import { useMobileSidebar, MobileSidebarOverlay } from './MobileSidebar';
import SetupBanner from './SetupBanner';

interface Props {
  children: React.ReactNode;
}

export default function PageShell({ children }: Props) {
  const { sidebarOpen, setSidebarOpen } = useMobileSidebar();

  return (
    <div className="flex h-screen overflow-hidden bg-[#0d1117]">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      <MobileSidebarOverlay />
      <div
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header with hamburger */}
        <div className="flex items-center h-12 px-4 border-b border-gray-800/50 bg-[#161b22] md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1 text-gray-400 hover:text-gray-200 transition-colors"
          >
            <Menu size={20} />
          </button>
        </div>
        {/* Setup banner for admins */}
        <SetupBanner />
        {children}
      </div>
    </div>
  );
}
