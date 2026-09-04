// Contact classification.
//
// THE PRIVACY RULE LIVES HERE, IN ONE PLACE, ON PURPOSE.
//
// We keep role-based business addresses (info@, wholesale@, sales@) and
// discard everything else. Named individuals' addresses are never stored —
// not filtered later, not stored "just in case": they never enter the
// database at all.
//
// Two reasons, one practical and one legal. Practically, wholesale@ reaches
// whoever currently handles wholesale, while john@ reaches a person who may
// have left. Legally, a role address attached to a business carries a
// materially different profile under GDPR and CCPA than an identifiable
// individual's contact details.
//
// The implementation is an ALLOWLIST, not a blocklist. A blocklist of
// name-like patterns will always leak — every unusual first name is a hole in
// it. An allowlist can only fail closed: an address we cannot positively
// identify as a role address is discarded. We lose a few usable contacts that
// way. That is the correct trade.

export type ContactRole =
  | "wholesale" | "sales" | "info" | "orders" | "support" | "press";

export interface RoleContact {
  email: string;
  localPart: string;
  domain: string;
  role: ContactRole;
  /** Lower sorts first. Wholesale outranks everything for a marketplace pitch. */
  priority: number;
  /** Provenance: the page this address was found on. Required for lawful basis. */
  sourceUrl: string;
}

/** Role tokens by priority. A local part matches if ANY of its tokens is here. */
const ROLE_TOKENS: { role: ContactRole; priority: number; tokens: string[] }[] = [
  { role: "wholesale", priority: 1,
    tokens: ["wholesale", "b2b", "bulk", "distribution", "distributor", "trade", "reseller", "retail"] },
  { role: "sales", priority: 2,
    tokens: ["sales", "partnerships", "partner", "business", "biz", "bd"] },
  { role: "info", priority: 3,
    tokens: ["info", "information", "hello", "hi", "contact", "enquiries", "enquiry",
             "inquiries", "inquiry", "general", "mail", "email", "team", "office"] },
  { role: "orders", priority: 4,
    tokens: ["orders", "order", "purchasing", "procurement", "buying"] },
  { role: "support", priority: 5,
    tokens: ["support", "help", "service", "customerservice", "customercare", "care", "cs"] },
  { role: "press", priority: 6,
    tokens: ["press", "media", "marketing", "pr"] },
];

/**
 * Addresses that are technically role-based but cannot receive real mail, or
 * that it would be inappropriate to send outreach to.
 */
const NEVER_CONTACT = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "bounce", "bounces",
  "mailer-daemon", "postmaster", "abuse", "security", "privacy", "legal",
  "dmca", "unsubscribe", "notifications", "notification", "alerts",
]);

/** Placeholder and vendor domains that appear in templates and boilerplate. */
const JUNK_DOMAINS = [
  "example.com", "example.org", "example.net", "domain.com", "yourdomain.com",
  "yoursite.com", "email.com", "test.com", "sentry.io", "wixpress.com",
  "godaddy.com", "squarespace.com", "shopify.com", "wordpress.com",
  "schema.org", "w3.org", "sentry-next.wixpress.com",
];

const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function splitEmail(email: string): { local: string; domain: string } | null {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(normalized)) return null;
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!local || !domain) return null;
  return { local, domain };
}

function isJunkDomain(domain: string): boolean {
  return JUNK_DOMAINS.some((junk) => domain === junk || domain.endsWith("." + junk));
}

/**
 * Classify a local part. Returns null for anything not positively identifiable
 * as a role address — which includes every personal name, by construction.
 */
export function classifyLocalPart(local: string): { role: ContactRole; priority: number } | null {
  const normalized = local.toLowerCase();
  if (NEVER_CONTACT.has(normalized)) return null;

  const tokens = normalized.split(/[._\-+]/).filter(Boolean);
  if (tokens.some((t) => NEVER_CONTACT.has(t))) return null;

  let best: { role: ContactRole; priority: number } | null = null;
  for (const token of tokens) {
    for (const entry of ROLE_TOKENS) {
      if (!entry.tokens.includes(token)) continue;
      if (!best || entry.priority < best.priority) {
        best = { role: entry.role, priority: entry.priority };
      }
    }
  }
  return best;
}

export function isRoleAddress(email: string): boolean {
  const parts = splitEmail(email);
  if (!parts || isJunkDomain(parts.domain)) return false;
  return classifyLocalPart(parts.local) !== null;
}

/**
 * Filter raw harvested addresses down to storable role contacts, sorted by
 * usefulness. Everything not positively a role address is dropped here and
 * never persisted.
 */
export function selectRoleContacts(emails: string[], sourceUrl: string): RoleContact[] {
  const bySpelling = new Map<string, RoleContact>();

  for (const raw of emails) {
    const parts = splitEmail(raw);
    if (!parts || isJunkDomain(parts.domain)) continue;

    const classification = classifyLocalPart(parts.local);
    if (!classification) continue;

    const email = `${parts.local}@${parts.domain}`;
    if (bySpelling.has(email)) continue;

    bySpelling.set(email, {
      email,
      localPart: parts.local,
      domain: parts.domain,
      role: classification.role,
      priority: classification.priority,
      sourceUrl,
    });
  }

  return [...bySpelling.values()].sort(
    (a, b) => a.priority - b.priority || a.email.localeCompare(b.email)
  );
}

/** The single address to write to, if any. */
export function bestContact(contacts: RoleContact[]): RoleContact | null {
  return contacts[0] ?? null;
}

/**
 * Prefer a contact on the company's own domain. A wholesale@gmail.com is a
 * legitimate contact for a small farm, but an address on the company domain is
 * stronger evidence we have reached the right business.
 */
export function preferOwnDomain(contacts: RoleContact[], companyDomain: string): RoleContact[] {
  const bare = companyDomain.toLowerCase().replace(/^www\./, "");
  const onDomain = (c: RoleContact) => c.domain === bare || c.domain.endsWith("." + bare);
  return [...contacts].sort((a, b) => {
    const diff = Number(onDomain(b)) - Number(onDomain(a));
    return diff !== 0 ? diff : a.priority - b.priority || a.email.localeCompare(b.email);
  });
}
