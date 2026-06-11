// Captured shapes of real `git diff --no-color --no-ext-diff --find-renames` output.

export const MODIFY_MULTI_HUNK = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import { a } from './a.js';
-import { b } from './b.js';
+import { b, bb } from './b.js';
+import { c } from './c.js';

 export function main() {
   return a + b;
@@ -20,3 +21,3 @@ export function helper() {
 }

-export const VERSION = '1.0.0';
+export const VERSION = '1.1.0';
`;

export const ADDED_FILE = `diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..b1a4c2e
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# New
+content
`;

export const DELETED_FILE = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;

export const PURE_RENAME = `diff --git a/README.md b/RENAMED.md
similarity index 100%
rename from README.md
rename to RENAMED.md
`;

export const RENAME_WITH_EDITS = `diff --git a/lib/util.ts b/lib/utils.ts
similarity index 90%
rename from lib/util.ts
rename to lib/utils.ts
index 1234567..89abcde 100644
--- a/lib/util.ts
+++ b/lib/utils.ts
@@ -1,3 +1,3 @@
-export const x = 1;
+export const x = 2;
 export const y = 2;
 export const z = 3;
`;

export const BINARY_FILE = `diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/img/logo.png differ
`;

export const NO_NEWLINE = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

export const MODE_ONLY = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`;

export const MULTI_FILE = ADDED_FILE + MODIFY_MULTI_HUNK + DELETED_FILE;
