import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-supabase-in-tests.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });

// Fails if the rule stops reporting for any lib/<dir>/supabase adapter or the shared client, reports an unrelated module, or a listed exception is removed.
tester.run("no-supabase-in-tests", rule, {
  valid: [
    { code: 'import { x } from "@/lib/store/supabase";', filename: "/repo/tests/db/store.test.ts" },
    { code: 'import { x } from "@/lib/store/supabase";', filename: "/repo/tests/store/supabase-failure.test.ts" },
    { code: 'import { x } from "@/lib/store/memory";', filename: "/repo/tests/store/memory.test.ts" },
    { code: 'import { x } from "@/lib/store/supabase";', filename: "/repo/src/lib/store/index.ts" },
    { code: 'import { x } from "@/lib/accounts/supabase";', filename: "/repo/tests/db/accounts.db.test.ts" },
    { code: 'import { x } from "@/lib/accounts/supabase";', filename: "/repo/tests/accounts/supabase-failure.test.ts" },
    { code: 'import { x } from "@/lib/accounts/memory";', filename: "/repo/tests/accounts/data.memory.test.ts" },
    { code: 'import { x } from "@/lib/supabase/client";', filename: "/repo/tests/db/store.test.ts" },
    { code: 'import { x } from "@/lib/supabase-helpers/format";', filename: "/repo/tests/api/x.test.ts" },
  ],
  invalid: [
    { code: 'import { x } from "@/lib/store/supabase.js";', filename: "/repo/tests/api/x.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/store/supabase/index";', filename: "/repo/tests/api/x.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'export { x } from "@/lib/store/supabase";', filename: "/repo/tests/api/x.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'export * from "@/lib/store/supabase";', filename: "/repo/tests/api/x.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/store/supabase";', filename: "/repo/tests/store/memory.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'const m = await import("../../src/lib/store/supabase.ts");', filename: "/repo/tests/api/x.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/accounts/supabase";', filename: "/repo/tests/api/notify.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/accounts/supabase";', filename: "/repo/tests/accounts/data.memory.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/claims/supabase";', filename: "/repo/tests/claims/verify.test.ts", errors: [{ messageId: "forbidden" }] },
    { code: 'import { x } from "@/lib/supabase/client";', filename: "/repo/tests/api/notify.test.ts", errors: [{ messageId: "forbidden" }] },
  ],
});
