"use strict";

const FUNCTION_SIGNATURE_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
  /^\s*def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:public|private|protected|internal|static|final|abstract|synchronized|\s)+[A-Za-z0-9_<>,\[\]?]+\s+([A-Za-z_][\w]*)\s*\(/,
];

const CLASS_SIGNATURE_PATTERNS = [
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*struct\s+([A-Za-z_$][\w$]*)\b/,
];

const IMPORT_PATTERNS = [
  /^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]\s*;?$/,
  /^\s*import\s+['"]([^'"]+)['"]\s*;?$/,
  /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(['"]([^'"]+)['"]\)\s*;?$/,
  /^\s*from\s+([A-Za-z0-9_./-]+)\s+import\s+/,
  /^\s*import\s+([A-Za-z0-9_.,\s]+)\s*$/,
  /^\s*#include\s+[<"]([^>"]+)[>"]\s*$/,
  /^\s*using\s+([A-Za-z0-9_.]+)\s*;?$/,
];

module.exports = {
  CLASS_SIGNATURE_PATTERNS,
  FUNCTION_SIGNATURE_PATTERNS,
  IMPORT_PATTERNS,
};
