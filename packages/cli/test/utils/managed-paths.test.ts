import { describe, expect, it } from "vitest";
import {
  removeTrellisManagedBlocks,
  TRELLIS_BLOCK_START as start,
  TRELLIS_BLOCK_END as end,
} from "../../src/utils/managed-paths.js";

describe("removeTrellisManagedBlocks", () => {
  it("removes complete blocks while preserving every outside byte", () => {
    const before = "# 用户说明\r\n\r\n\r\npython3 .trellis/custom.py  \r\n";
    const after = "\r\n\r\n## Tail  \r\n\r\n";
    expect(
      removeTrellisManagedBlocks(
        before + start + "\r\nold path\r\n" + end + after,
      ),
    ).toBe(before + after);
    expect(removeTrellisManagedBlocks(start + "old" + end)).toBe("");
    expect(
      removeTrellisManagedBlocks(
        "a" + start + "old" + end + "b" + start + "old" + end + "c",
      ),
    ).toBe("abc");
  });

  it.each([
    "notes",
    start + "unterminated",
    end,
    start + start + end + end,
    end + start + end,
    start + end + start,
  ])("leaves missing or ambiguous markers untouched: %s", (content) => {
    expect(removeTrellisManagedBlocks(content)).toBeNull();
  });
});
