import React, { useState, useEffect, useContext } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, X, ArrowRight } from 'lucide-react';
import { api } from '../../api/http';
import { AuthContext } from '../../App';

export default function SetupBanner() {
  const { role } = useContext(AuthContext);
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (role !== 'admin') return;

    // Check if dismissed this session
    const sessionDismissed = sessionStorage.getItem('setup_banner_dismissed');
    if (sessionDismissed) {
      setDismissed(true);
      return;
    }

    // Check if base_domain is set
    api.get<Record<string, any>>('/settings').then(data => {
      if (!data.base_domain?.value) {
        setShow(true);
      }
    }).catch(() => {});
  }, [role]);

  const handleDismiss = () => {
    sessionStorage.setItem('setup_banner_dismissed', 'true');
    setDismissed(true);
  };

  if (role !== 'admin' || !show || dismissed) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5">
      <div className="flex items-center justify-between gap-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-3 text-amber-400">
          <AlertCircle size={18} className="flex-shrink-0" />
          <span className="text-sm">
            Set your base domain to enable project subdomain URLs.
          </span>
          <Link
            to="/config"
            className="inline-flex items-center gap-1 text-sm font-medium text-amber-300 hover:text-amber-200 transition-colors"
          >
            Go to Settings
            <ArrowRight size={14} />
          </Link>
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 text-amber-400/60 hover:text-amber-400 transition-colors"
          title="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
