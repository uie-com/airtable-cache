import { describe, expect, it } from "vitest";

import {
  cloneJsonObject,
  isJsonObject,
  stripOffsetField,
} from "@/lib/airtable-cache/types";
import {
  EXAMPLE_PAGINATED_PAGE_ONE,
  EXAMPLE_TOPICS_BODY,
} from "@/tests/fixtures/cache-example";

describe("airtable cache types helpers", () => {
  it("identifies JSON objects and rejects arrays and null", () => {
    expect(isJsonObject(EXAMPLE_TOPICS_BODY)).toBe(true);
    expect(isJsonObject(["not", "an", "object"])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  it("deep clones JSON objects", () => {
    const cloned = cloneJsonObject(EXAMPLE_TOPICS_BODY);

    expect(cloned).toEqual(EXAMPLE_TOPICS_BODY);
    expect(cloned).not.toBe(EXAMPLE_TOPICS_BODY);

    const clonedRecords = cloned.records as { fields: { Name: string } }[];
    clonedRecords[0].fields.Name = "Changed in test";

    const originalRecords = EXAMPLE_TOPICS_BODY.records as { fields: { Name: string } }[];
    expect(originalRecords[0].fields.Name).toBe("Pillar 2");
  });

  it("removes offset without mutating the original object", () => {
    const stripped = stripOffsetField(EXAMPLE_PAGINATED_PAGE_ONE);

    expect(stripped).not.toHaveProperty("offset");
    expect(EXAMPLE_PAGINATED_PAGE_ONE).toHaveProperty("offset");
    expect(stripped.records).toEqual(EXAMPLE_PAGINATED_PAGE_ONE.records);
  });
});
