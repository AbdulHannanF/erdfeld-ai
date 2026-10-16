'use client'

import { useState, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { formatDistanceToNow } from 'date-fns'
import {
  Bell, CheckCheck, Trash2, Wrench, Layers, Activity, AlertTriangle,
} from 'lucide-react'
import { useStore, type Notification } from '@/store/useStore'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// ---------------------------------------------------------------------------
// Type icon + color mapping
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<
  Notification['type'],
  { icon: React.ElementType; color: string; bgColor: string }
> = {
  tool_complete: {
    icon: Wrench,
    color: 'text-brand-text',
    bgColor: 'bg-brand-500/15',
  },
  layer_added: {
    icon: Layers,
    color: 'text-brand-text',
    bgColor: 'bg-aqua-500/15',
  },
  analysis: {
    icon: Activity,
    color: 'text-brand-text',
    bgColor: 'bg-brand-500/15',
  },
  system: {
    icon: AlertTriangle,
    color: 'text-brand-text',
    bgColor: 'bg-primary/15',
  },
}

// ---------------------------------------------------------------------------
// Single notification row
// ---------------------------------------------------------------------------

function NotificationRow({
  notification,
  onMarkRead,
}: {
  notification: Notification
  onMarkRead: (id: string) => void
}) {
  const config = TYPE_CONFIG[notification.type]
  const Icon = config.icon
  const relativeTime = formatDistanceToNow(notification.timestamp, { addSuffix: true })

  return (
    <motion.button
      layout
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20, height: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onClick={() => {
        if (!notification.read) onMarkRead(notification.id)
      }}
      className={`w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 group ${
        notification.read
          ? 'bg-transparent hover:bg-foreground/[0.03]'
          : 'bg-foreground/[0.04] hover:bg-foreground/[0.06]'
      }`}
    >
      {/* Type icon */}
      <div
        className={`flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg ${config.bgColor}`}
      >
        <Icon className={`h-4 w-4 ${config.color}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-body-strong leading-tight truncate ${
              notification.read ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {notification.title}
          </span>
          {/* Unread indicator */}
          {!notification.read && (
            <span className="flex-shrink-0 h-2 w-2 rounded-full bg-brand-400 animate-pulse shadow-sm" />
          )}
        </div>
        <p className="text-caption text-muted-foreground leading-snug mt-0.5 line-clamp-2">
          {notification.description}
        </p>
        <span className="text-data text-muted-foreground mt-1 block">
          {relativeTime}
        </span>
      </div>
    </motion.button>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <div className="flex items-center justify-center h-14 w-14 rounded-lg bg-muted/50 border border-border mb-4">
        <Bell className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-body-strong text-muted-foreground">No notifications yet</p>
      <p className="text-caption text-muted-foreground mt-1">
        Alerts will appear here when tools complete or layers are added
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component: Bell trigger + Sheet panel
// ---------------------------------------------------------------------------

export default function NotificationPanel() {
  const notifications = useStore((s) => s.notifications)
  const unreadCount = useStore((s) => s.unreadCount)
  const markNotificationRead = useStore((s) => s.markNotificationRead)
  const clearNotifications = useStore((s) => s.clearNotifications)

  const [open, setOpen] = useState(false)
  const [animateBadge, setAnimateBadge] = useState(false)

  // Mark all as read
  const handleMarkAllRead = useCallback(() => {
    for (const n of notifications) {
      if (!n.read) markNotificationRead(n.id)
    }
  }, [notifications, markNotificationRead])

  // Animate badge when unread count increases
  useEffect(() => {
    // Store tracks unreadCount, when it changes, briefly animate
    const showTimer = setTimeout(() => setAnimateBadge(true), 0)
    const hideTimer = setTimeout(() => setAnimateBadge(false), 600)
    return () => {
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
    }
  }, [unreadCount])

  return (
    <>
      {/* Bell trigger button */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Icon-only trigger: the tooltip is hover chrome, so without an
                aria-label a screen reader announces nothing at all here. */}
            <Button
              variant="ghost"
              size="icon-md"
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              aria-expanded={open}
              className="relative"
              onClick={() => setOpen(true)}
            >
              <Bell className="h-3.5 w-3.5" />
              {unreadCount > 0 && (
                <span
                  className={`absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[0.875rem] h-[0.875rem] rounded-full bg-primary text-caption-strong text-primary-foreground shadow-lg transition-transform duration-300 ${
                    animateBadge ? 'scale-150' : 'scale-100'
                  }`}
                >
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Notification Sheet */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[23.75rem] bg-card/95 border-l border-border p-0 flex flex-col"
        >
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <SheetTitle>
                  Notifications
                </SheetTitle>
                <SheetDescription className="text-caption text-muted-foreground mt-0.5">
                  {unreadCount > 0
                    ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
                    : 'All caught up'}
                </SheetDescription>
              </div>
              <div className="flex items-center gap-1.5">
                {/* Mark all as read */}
                {unreadCount > 0 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Mark all as read"
                          onClick={handleMarkAllRead}
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Mark all as read</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Clear all with confirmation */}
                {notifications.length > 0 && (
                  <AlertDialog>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Clear all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Clear all</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <AlertDialogContent className="bg-card border-border text-foreground">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-foreground">
                          Clear All Notifications
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-muted-foreground">
                          This will remove all notifications. Are you sure?
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="bg-muted border-border text-muted-foreground hover:bg-secondary hover:text-foreground">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={clearNotifications}
                          className="bg-danger text-danger-foreground hover:bg-danger/90 border-0 focus:ring-danger/40"
                        >
                          Clear All
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          </SheetHeader>

          {/* Notification list */}
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              <AnimatePresence mode="popLayout">
                {notifications.length === 0 ? (
                  <EmptyState />
                ) : (
                  notifications.map((n) => (
                    <NotificationRow
                      key={n.id}
                      notification={n}
                      onMarkRead={markNotificationRead}
                    />
                  ))
                )}
              </AnimatePresence>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}
