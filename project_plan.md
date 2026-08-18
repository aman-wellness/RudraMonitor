# Rudrans - Employee Monitoring SaaS Tool

## 1. Project Description
**Rudrans** ek cloud-based employee monitoring SaaS tool hai jo Windows, macOS, aur Ubuntu systems ko real-time mein monitor karta hai. Iska target audience IT heads, HR managers, aur business owners hain jo apni team ki productivity track karna chahte hain. Core value: complete visibility into employee activities, AI-powered insights, aur enterprise-grade security.

## 2. Page Structure
- `/` - Landing Page (Marketing Homepage)
- `/login` - Login (Google, Microsoft, Email)
- `/signup` - Signup with Organization Details
- `/dashboard` - Main Dashboard
- `/monitoring` - Monitoring (Application + Browser + Videos + Screenshots + Idle)
- `/alerts` - Alerts & AI Auto-Resolution
- `/system-health` - System Health (CPU, RAM, Disk, Battery, Network)
- `/performance-reports` - AI Performance Reports & Analytics
- `/admin-portal` - Admin Portal (Manage Agents, Licenses, Users)

## 3. Core Features
- [ ] Application Monitoring - Live app tracking with activity logs
- [ ] Browser Monitoring - Website access tracking per browser
- [ ] Video Recording - 10-min interval clips for unauthorized activity
- [ ] Real-time Screenshots - Activity-based screen capture
- [ ] Idle Mode Tracking - Time-based idle capture with video
- [ ] AI Alerts & Auto-Resolution - System alerts with AI fix
- [ ] System Health Dashboard - CPU, RAM, Disk, Battery, Network, Speed
- [ ] AI Performance Charts - 1-year max performance reports
- [ ] Login/Logout Tracking - With timestamps
- [ ] Active Hours Calculation - Shift-based excluding idle
- [ ] 14-day Free Trial - Auto-activate on signup
- [ ] License-based Subscription - Per agent/user licensing
- [ ] GST Auto-fetch - Auto-fill company details from GST
- [ ] Partner-based Subscription - Show partner details
- [ ] Google/Microsoft/Email Auth

## 4. Data Model Design
### Table: organizations
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| name | text | Company name |
| gst_number | text | GST number (optional) |
| address | text | Company address |
| city | text | City |
| state | text | State |
| country | text | Country |
| phone | text | Contact phone |
| created_at | timestamp | Signup date |
| trial_ends_at | timestamp | Trial end date |
| subscription_status | text | active/trial/expired |
| subscription_type | text | monthly/yearly |
| license_count | int | Number of licenses |
| license_key | text | Activation key |

### Table: agents
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| org_id | uuid | FK to organizations |
| agent_name | text | System/user name |
| os_type | text | Windows/macOS/Ubuntu |
| status | text | online/offline |
| last_active | timestamp | Last seen |
| ip_address | text | System IP |

### Table: activity_logs
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| agent_id | uuid | FK to agents |
| activity_type | text | app/browser/idle/alert |
| application_name | text | App name |
| url | text | Browser URL |
| duration | int | Seconds |
| screenshot_url | text | Screenshot path |
| video_url | text | Video clip path |
| created_at | timestamp | Log time |

### Table: system_metrics
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| agent_id | uuid | FK to agents |
| cpu_usage | int | CPU % |
| ram_usage | int | RAM % |
| disk_usage | int | Disk % |
| battery_level | int | Battery % |
| network_speed | text | Upload/Download |
| recorded_at | timestamp | Metric time |

### Table: alerts
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| agent_id | uuid | FK to agents |
| alert_type | text | error/warning/info |
| message | text | Alert message |
| ai_resolved | boolean | AI fixed it? |
| resolution | text | AI resolution |
| created_at | timestamp | Alert time |

## 5. Backend / Third-party Integration Plan
- **Supabase**: Auth (Google/Microsoft/Email), Database, Storage (screenshots/videos), Edge Functions
- **Shopify**: Not needed (subscription via partner, not direct payment)
- **Stripe**: Not needed (partner-based billing)
- **Edge Functions**: Agent data collection API, GST verification API, AI alert resolution

## 6. Development Phase Plan

### Phase 1: Landing Page (Marketing Homepage)
- Goal: Professional landing page with all marketing sections
- Deliverable: Complete homepage with Hero, Features, Pricing, Testimonials, CTA, Footer
- Pages: `/` only

### Phase 2: Authentication Pages
- Goal: Login and Signup with org details
- Deliverable: Login page, Signup page with GST auto-fetch
- Pages: `/login`, `/signup`

### Phase 3: Dashboard ✅
- Goal: Main admin dashboard with overview
- Deliverable: Dashboard with agent list, quick stats, charts, activity feed, alerts
- Pages: `/dashboard`
- Status: Complete with sidebar, stat cards, agent table with filters, productivity chart, recent activity, AI alerts summary

### Phase 4: Core Monitoring Pages
- Goal: Monitoring, Alerts, System Health, Reports, Agent Setup
- Deliverable: 5 full pages with mock data
- Pages: `/monitoring`, `/alerts`, `/system-health`, `/performance-reports`, `/setup`
- Status: Monitoring page (`/monitoring`) complete with 5 tabs: Applications, Browser, Videos, Screenshots, Idle
- Agent Detail page (`/agents/:agentId`) complete with full per-agent monitoring: header, date filters, 8 stat cards, 6 quick stats, activity timeline chart, 8 bottom tabs, time-per-application bar chart
- Agent Setup page (`/setup`) complete with OS download cards for Windows (.msi), macOS (.dmg), Ubuntu (.deb/.rpm), license key display, mass deployment guide, connected agents by OS summary

### Phase 5: Admin Portal
- Goal: Full admin management portal
- Deliverable: Agent management, license management, subscription details
- Pages: `/admin-portal`

### Phase 6: Backend Integration
- Goal: Connect Supabase, implement real data flow
- Deliverable: Full auth, database, storage integration
- Edge functions, RLS policies, real-time updates