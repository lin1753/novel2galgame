/**
 * 编码检测与转换 - 将各种中文编码统一为 UTF-8
 */

const GBK_ENCODINGS = ["gbk", "gb2312", "gb18030"];

export function detectAndDecode(input: Buffer | string): { text: string; encoding: string } {
  if (typeof input === "string") {
    return { text: input, encoding: "utf-8" };
  }

  // Check for UTF-8 BOM
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return { text: input.subarray(3).toString("utf-8"), encoding: "utf-8-bom" };
  }

  // Check for UTF-16 BOM
  if (input.length >= 2) {
    if (input[0] === 0xff && input[1] === 0xfe) {
      return { text: input.toString("utf16le"), encoding: "utf-16le" };
    }
    if (input[0] === 0xfe && input[1] === 0xff) {
      return { text: input.subarray(2).toString("utf16le"), encoding: "utf-16be" };
    }
  }

  // Try UTF-8 first
  const asUtf8 = input.toString("utf-8");
  if (!hasInvalidUtf8Sequences(input) && hasReasonableCJK(asUtf8)) {
    return { text: asUtf8, encoding: "utf-8" };
  }

  // Try GB18030 (superset of GBK, wider CJK coverage)
  try {
    const decoder = new TextDecoder("gb18030");
    const asGb18030 = decoder.decode(input);
    if (hasReasonableCJK(asGb18030)) {
      return { text: asGb18030, encoding: "gb18030" };
    }
  } catch {}

  // Try Big5 (traditional Chinese)
  try {
    const decoder = new TextDecoder("big5");
    const asBig5 = decoder.decode(input);
    if (hasReasonableCJK(asBig5)) {
      return { text: asBig5, encoding: "big5" };
    }
  } catch {}

  // Try GBK as last CJK fallback
  try {
    const decoder = new TextDecoder("gbk");
    const asGbk = decoder.decode(input);
    if (hasReasonableCJK(asGbk)) {
      return { text: asGbk, encoding: "gbk" };
    }
  } catch {}

  // If all CJK encodings fail, try UTF-8 without strict CJK check
  if (!hasInvalidUtf8Sequences(input)) {
    return { text: asUtf8, encoding: "utf-8" };
  }

  // Last resort: UTF-8
  return { text: asUtf8, encoding: "utf-8 (fallback)" };
}

function hasInvalidUtf8Sequences(buf: Buffer): boolean {
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i];
    if (byte < 0x80) {
      i++;
    } else if ((byte & 0xe0) === 0xc0) {
      if (i + 1 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80) return true;
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      if (i + 2 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80)
        return true;
      i += 3;
    } else if ((byte & 0xf8) === 0xf0) {
      if (
        i + 3 >= buf.length ||
        (buf[i + 1] & 0xc0) !== 0x80 ||
        (buf[i + 2] & 0xc0) !== 0x80 ||
        (buf[i + 3] & 0xc0) !== 0x80
      )
        return true;
      i += 4;
    } else {
      return true;
    }
  }
  return false;
}

function hasReasonableCJK(text: string): boolean {
  // Check if at least 10% of non-whitespace characters are CJK
  const noWhitespace = text.replace(/\s/g, "");
  if (noWhitespace.length === 0) return false;
  const cjkCount = (noWhitespace.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  return cjkCount / noWhitespace.length > 0.1;
}
