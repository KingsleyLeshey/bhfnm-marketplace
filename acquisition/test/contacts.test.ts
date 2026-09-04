import { describe, expect, it } from "vitest";
import {
  bestContact,
  classifyLocalPart,
  isRoleAddress,
  preferOwnDomain,
  selectRoleContacts,
  splitEmail,
} from "../src/extract/contacts";

describe("splitEmail", () => {
  it("normalizes and splits", () => {
    expect(splitEmail(" Info@Acme.COM ")).toEqual({ local: "info", domain: "acme.com" });
  });

  it("rejects malformed addresses", () => {
    expect(splitEmail("not-an-email")).toBeNull();
    expect(splitEmail("a@b")).toBeNull();
    expect(splitEmail("@acme.com")).toBeNull();
  });
});

describe("classifyLocalPart — the privacy rule", () => {
  it("accepts plain role addresses", () => {
    expect(classifyLocalPart("wholesale")?.role).toBe("wholesale");
    expect(classifyLocalPart("sales")?.role).toBe("sales");
    expect(classifyLocalPart("info")?.role).toBe("info");
    expect(classifyLocalPart("support")?.role).toBe("support");
  });

  it("accepts qualified role addresses", () => {
    expect(classifyLocalPart("wholesale-team")?.role).toBe("wholesale");
    expect(classifyLocalPart("sales.us")?.role).toBe("sales");
    expect(classifyLocalPart("info_desk")?.role).toBe("info");
  });

  it("REJECTS personal names — the whole point of the allowlist", () => {
    expect(classifyLocalPart("john")).toBeNull();
    expect(classifyLocalPart("john.smith")).toBeNull();
    expect(classifyLocalPart("jsmith")).toBeNull();
    expect(classifyLocalPart("j.smith")).toBeNull();
    expect(classifyLocalPart("kingsley")).toBeNull();
  });

  it("rejects unusual names too — a blocklist would leak these", () => {
    expect(classifyLocalPart("xochitl")).toBeNull();
    expect(classifyLocalPart("bartholomew.q.finch")).toBeNull();
  });

  it("rejects unattended and sensitive mailboxes", () => {
    expect(classifyLocalPart("noreply")).toBeNull();
    expect(classifyLocalPart("no-reply")).toBeNull();
    expect(classifyLocalPart("postmaster")).toBeNull();
    expect(classifyLocalPart("abuse")).toBeNull();
    expect(classifyLocalPart("legal")).toBeNull();
    expect(classifyLocalPart("unsubscribe")).toBeNull();
  });

  it("rejects a role token combined with a never-contact token", () => {
    expect(classifyLocalPart("sales-noreply")).toBeNull();
  });

  it("picks the highest-value role when several match", () => {
    expect(classifyLocalPart("wholesale.sales")?.role).toBe("wholesale");
  });

  it("does not match a role token as a substring", () => {
    // "information" is listed explicitly; "misinformation" must not match.
    expect(classifyLocalPart("information")?.role).toBe("info");
    expect(classifyLocalPart("misinformation")).toBeNull();
  });
});

describe("isRoleAddress", () => {
  it("accepts business role addresses on any host", () => {
    expect(isRoleAddress("wholesale@acmehemp.com")).toBe(true);
    // Small farms genuinely use free mail for their wholesale line.
    expect(isRoleAddress("wholesale@gmail.com")).toBe(true);
  });

  it("rejects personal addresses", () => {
    expect(isRoleAddress("john.smith@acmehemp.com")).toBe(false);
  });

  it("rejects placeholder and vendor domains", () => {
    expect(isRoleAddress("info@example.com")).toBe(false);
    expect(isRoleAddress("info@yourdomain.com")).toBe(false);
    expect(isRoleAddress("sales@sentry.io")).toBe(false);
  });
});

describe("selectRoleContacts", () => {
  const src = "https://acme.com/contact";

  it("keeps only role addresses and records provenance", () => {
    const out = selectRoleContacts(
      ["john.smith@acme.com", "wholesale@acme.com", "info@example.com"], src
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.email).toBe("wholesale@acme.com");
    expect(out[0]!.sourceUrl).toBe(src);
  });

  it("sorts wholesale ahead of sales ahead of info", () => {
    const out = selectRoleContacts(
      ["info@acme.com", "sales@acme.com", "wholesale@acme.com"], src
    );
    expect(out.map((c) => c.role)).toEqual(["wholesale", "sales", "info"]);
  });

  it("deduplicates case variants", () => {
    expect(selectRoleContacts(["Info@Acme.com", "info@acme.com"], src)).toHaveLength(1);
  });

  it("returns nothing when a page has only personal addresses", () => {
    expect(selectRoleContacts(["jane@acme.com", "bob.jones@acme.com"], src)).toEqual([]);
  });

  it("handles an empty input", () => {
    expect(selectRoleContacts([], src)).toEqual([]);
  });
});

describe("bestContact", () => {
  it("returns the top-priority contact, or null", () => {
    const contacts = selectRoleContacts(["info@a.com", "wholesale@a.com"], "u");
    expect(bestContact(contacts)?.role).toBe("wholesale");
    expect(bestContact([])).toBeNull();
  });
});

describe("preferOwnDomain", () => {
  it("puts company-domain addresses first, then priority", () => {
    const contacts = selectRoleContacts(
      ["wholesale@gmail.com", "info@acme.com"], "u"
    );
    const sorted = preferOwnDomain(contacts, "acme.com");
    expect(sorted[0]!.email).toBe("info@acme.com");
  });

  it("keeps priority order within the same domain group", () => {
    const contacts = selectRoleContacts(["info@acme.com", "wholesale@acme.com"], "u");
    expect(preferOwnDomain(contacts, "acme.com")[0]!.role).toBe("wholesale");
  });
});
