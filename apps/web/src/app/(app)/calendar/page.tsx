'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  format,
  isSameMonth,
  isToday,
  isSameDay,
  getMonth,
  getYear,
  setMonth,
  setYear,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { InlineError, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { ContentPostView } from '@/lib/types';
import { CalendarEvent } from '@/components/calendar/calendar-event';

export default function CalendarPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentDate, setCurrentDate] = useState(new Date());

  async function loadPosts() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      // In a real app, you might want to fetch by date range, but here we fetch the limit
      const result = await postsApi.list(workspace.id, { limit: 100 });
      setPosts(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPosts();
  }, [workspace]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('scheduled')) {
      toast.success('Đã lên lịch bài viết.');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }
  }, [toast]);

  const scheduledPosts = useMemo(() => posts.filter((post) => post.scheduledAt), [posts]);

  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const goToday = () => setCurrentDate(new Date());

  // Generate Calendar Grid
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 }); // Monday
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const calendarDays: Date[] = [];
  let day = startDate;
  while (day <= endDate) {
    calendarDays.push(day);
    day = addDays(day, 1);
  }

  const WEEKDAYS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  return (
    <div className="flex h-full flex-col space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Calendar</h1>
          <p className="mt-1 text-sm text-slate-600">Lịch đăng bài tự động</p>
        </div>
        <div className="flex gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadPosts()} type="button">
            Làm mới
          </SecondaryButton>
          <Link
            className="inline-flex h-10 items-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white transition hover:bg-brand-700"
            href="/posts/new"
          >
            Tạo post
          </Link>
        </div>
      </header>

      <InlineError message={error} />

      <div className="flex items-center justify-between rounded-t-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <select
            value={getMonth(currentDate)}
            onChange={(e) => setCurrentDate(setMonth(currentDate, parseInt(e.target.value, 10)))}
            className="cursor-pointer rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-8 text-xl font-semibold text-slate-900 transition-colors hover:bg-slate-100 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i}>
                Tháng {i + 1}
              </option>
            ))}
          </select>
          <select
            value={getYear(currentDate)}
            onChange={(e) => setCurrentDate(setYear(currentDate, parseInt(e.target.value, 10)))}
            className="cursor-pointer rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-8 text-xl font-semibold text-slate-900 transition-colors hover:bg-slate-100 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {Array.from({ length: 11 }, (_, i) => {
              const y = new Date().getFullYear() - 5 + i;
              return (
                <option key={y} value={y}>
                  {y}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={goToday} type="button">
            Hôm nay
          </SecondaryButton>
          <button
            type="button"
            onClick={prevMonth}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            onClick={nextMonth}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 rounded-b-xl border-x border-b border-slate-200 bg-white shadow-sm">
        {/* Header Row */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {WEEKDAYS.map((dayName) => (
            <div
              key={dayName}
              className="py-3 text-center text-sm font-medium text-slate-600 border-r border-slate-200 last:border-r-0"
            >
              {dayName}
            </div>
          ))}
        </div>

        {/* Days Grid */}
        <div className="grid grid-cols-7 bg-slate-200 gap-[1px]">
          {calendarDays.map((date) => {
            const isCurrentMonth = isSameMonth(date, monthStart);
            const isCurrentDay = isToday(date);

            // Find posts for this day
            const dailyPosts = scheduledPosts.filter((post) => {
              if (!post.scheduledAt) return false;
              return isSameDay(new Date(post.scheduledAt), date);
            });

            return (
              <div
                key={date.toISOString()}
                className={`min-h-[120px] bg-white p-2 transition-colors ${
                  !isCurrentMonth
                    ? 'text-slate-400 bg-slate-50'
                    : 'text-slate-900 hover:bg-slate-50'
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium ${
                      isCurrentDay ? 'bg-brand-600 text-white' : ''
                    }`}
                  >
                    {format(date, 'd')}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {dailyPosts.map((post) => (
                    <CalendarEvent key={post.id} post={post} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
