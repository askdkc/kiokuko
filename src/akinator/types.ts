import type { EntryRecord } from '../memory/entries.js';

export const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskProfile {
  taskType: TaskType | null;
  target: string | null;
  expected: string | null;
  constraints: string | null;
}

export interface AkinatorQuestion {
  id: keyof TaskProfile;
  prompt: string;
  options: string[] | null;
  required: boolean;
}

export interface AkinatorSessionView {
  id: string;
  workspace: string;
  task: string;
  profile: TaskProfile;
  status: 'active' | 'ready' | 'exhausted';
  questionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSyncSummary {
  attempted: boolean;
  imported: number;
  sources: Array<{
    sourceId: string;
    commit: string | null;
    documents: number;
    imported: number;
    error?: string;
  }>;
}

export interface AkinatorResult {
  status: 'needs_answer' | 'ready' | 'exhausted';
  session: AkinatorSessionView;
  question: AkinatorQuestion | null;
  missingFields: Array<keyof TaskProfile>;
  recommendedTags: string[];
}

export interface AkinatorContext extends AkinatorResult {
  entries: EntryRecord[];
  instructions: string[];
  externalSync: ExternalSyncSummary;
}
