import {
  Actor,
  EventLogEntry,
  EventType,
  RiskLevel,
  ThreadState,
} from '../types';
import { getRepos } from '../repositories';
import { CreateEventParams } from '../repositories/interfaces';

export type { CreateEventParams };

export async function createEvent(params: CreateEventParams): Promise<EventLogEntry> {
  return getRepos().events.create(params);
}

export async function logStateTransition(params: {
  group_id: string;
  issue_thread_id: string;
  from_state: ThreadState;
  to_state: ThreadState;
  actor?: Actor;
  actor_user_id?: string | null;
  detail?: string | null;
}): Promise<EventLogEntry> {
  return createEvent({
    event_type: EventType.STATE_TRANSITION,
    group_id: params.group_id,
    issue_thread_id: params.issue_thread_id,
    actor: params.actor ?? Actor.SYSTEM,
    actor_user_id: params.actor_user_id ?? null,
    from_state: params.from_state,
    to_state: params.to_state,
    detail: params.detail ?? null,
  });
}

export async function getEventLogs(): Promise<EventLogEntry[]> {
  return getRepos().events.findAll();
}

export async function getEventsByGroup(groupId: string): Promise<EventLogEntry[]> {
  return getRepos().events.findByGroup(groupId);
}

export async function getEventsByType(eventType: EventType): Promise<EventLogEntry[]> {
  return getRepos().events.findByType(eventType);
}

export async function clearEventLogs(): Promise<void> {
  await getRepos().events.clear();
}
