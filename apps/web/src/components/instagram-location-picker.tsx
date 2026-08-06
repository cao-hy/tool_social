import React, { useState, useEffect, useRef } from 'react';
import { socialAccountsApi } from '../lib/api-client';

interface Location {
  id: string;
  name: string;
  location?: {
    city?: string;
    country?: string;
  };
}

interface InstagramLocationPickerProps {
  workspaceId: string;
  socialAccountId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function InstagramLocationPicker({
  workspaceId,
  socialAccountId,
  value,
  onChange,
  disabled,
}: InstagramLocationPickerProps) {
  const [query, setQuery] = useState(value);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value && query !== value) {
      setQuery(value);
    }
  }, [value, query]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!query || query.length < 2) {
      setLocations([]);
      return;
    }

    if (query === value) return;

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await socialAccountsApi.instagramLocations(
          workspaceId,
          socialAccountId,
          query,
        );
        setLocations(results);
        setOpen(true);
      } catch (err) {
        console.error('Failed to search locations:', err);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [query, workspaceId, socialAccountId, value]);

  const handleSelect = (loc: Location) => {
    setQuery(loc.name);
    onChange(loc.id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        disabled={disabled}
        value={query}
        placeholder="Tìm kiếm địa điểm..."
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value === '') {
            onChange('');
          }
        }}
        onFocus={() => {
          if (locations.length > 0) setOpen(true);
        }}
        className={
          'h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500'
        }
      />

      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"></div>
        </div>
      )}

      {open && locations.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
          {locations.map((loc) => {
            const address = [loc.location?.city, loc.location?.country].filter(Boolean).join(', ');
            return (
              <li
                key={loc.id}
                onClick={() => handleSelect(loc)}
                className="relative cursor-default select-none py-2 pl-3 pr-9 hover:bg-brand-50 hover:text-brand-900 cursor-pointer text-slate-900"
              >
                <span className="block truncate font-medium">{loc.name}</span>
                {address && (
                  <span className="block truncate text-xs text-slate-500">{address}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
