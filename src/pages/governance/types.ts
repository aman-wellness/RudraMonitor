// Shared types for /governance pages. Mirror the SQL schema from migration 0111.

export type GovRole = 'owner' | 'admin' | 'editor' | 'view' | 'external';

export type GovPillarStatus = 'filled' | 'hiring' | 'vacant' | 'archived';

export type GovChannelLayer = 'L1' | 'L2' | 'L3';

export type GovMemberType = 'member' | 'guest' | 'external';

export interface GovPillar {
  id: string;
  org_id: string;
  code: string;
  name: string;
  color: string;
  functions_desc: string | null;
  reports_to_pillar_id: string | null;
  hiring_flag: boolean;
  status: GovPillarStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface GovPillarSummary {
  id: string;
  org_id: string;
  code: string;
  name: string;
  color: string;
  functions_desc: string | null;
  reports_to_pillar_id: string | null;
  hiring_flag: boolean;
  status: GovPillarStatus;
  sort_order: number;
  owner_name: string | null;
  backup_name: string | null;
  member_count: number;
  platform_count: number;
}

export interface GovPillarAssignment {
  id: string;
  org_id: string;
  pillar_id: string;
  employee_id: string;
  role: GovRole;
  is_acting: boolean;
  notes: string | null;
  created_at: string;
}

export interface GovPillarPlatform {
  id: string;
  org_id: string;
  pillar_id: string;
  platform_name: string;
  platform_type: string | null;
  access_method: string | null;
  ownership_email: string | null;
  it_registered: boolean;
  credential_id: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export interface GovChannel {
  id: string;
  org_id: string;
  layer: GovChannelLayer;
  name: string;
  purpose: string | null;
  parent_channel_id: string | null;
  primary_pillar_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface GovChannelMember {
  id: string;
  org_id: string;
  channel_id: string;
  employee_id: string;
  member_type: GovMemberType;
  created_at: string;
}

export interface GovAccessRegister {
  id: string;
  org_id: string;
  platform_id: string;
  employee_id: string | null;
  role_label: string;
  email_format: string | null;
  access_level: GovRole;
  last_reviewed_at: string | null;
  last_reviewed_by: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface GovPolicy {
  id: string;
  org_id: string;
  code: string;
  body: string;
  enforced_by: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GovAuditEvent {
  id: number;
  org_id: string;
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

// Shared lookups used by multiple components.
export interface OrgUser {
  row_id: string;
  display_name: string;
  work_email: string | null;
  employee_id: string | null;
  has_we_record: boolean;
}

// Pill color mapping — copied from the governance HTML doc's CSS variables
// so role pills match the source-of-truth visual identity 1:1.
export const ROLE_PILL: Record<GovRole, { bg: string; fg: string; border: string; label: string }> = {
  owner:    { bg: '#1a1a1a',  fg: '#ffffff', border: '#1a1a1a', label: 'Owner' },
  admin:    { bg: '#edf3fb',  fg: '#1d5fa6', border: '#b8d0ef', label: 'Admin' },
  editor:   { bg: '#e8f5ef',  fg: '#176044', border: '#b2d9c8', label: 'Editor' },
  view:     { bg: '#f0ede8',  fg: '#777470', border: '#e2dfd9', label: 'View'  },
  external: { bg: '#f5f0ff',  fg: '#5535a0', border: '#cfc0f0', label: 'External' },
};

export const STATUS_PILL: Record<GovPillarStatus, { bg: string; fg: string; border: string; label: string }> = {
  filled:   { bg: '#e8f5ef', fg: '#176044', border: '#b2d9c8', label: 'Filled' },
  hiring:   { bg: '#fff8e6', fg: '#7a5500', border: '#f0c040', label: 'Hiring' },
  vacant:   { bg: '#fdf0f0', fg: '#8f1f1f', border: '#f0c4c4', label: 'Vacant' },
  archived: { bg: '#f0ede8', fg: '#777470', border: '#e2dfd9', label: 'Archived' },
};
