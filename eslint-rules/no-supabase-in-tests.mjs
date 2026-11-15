// Forbids importing the Supabase store adapter from tests outside tests/db/**,
// except the listed file that uses a closed port and needs no database.
const ALLOWED = ["tests/store/supabase-failure.test.ts"];

export default {
  meta: { type: "problem", messages: { forbidden: "Import the Supabase adapter only from tests/db/** (or the listed exception)." }, schema: [] },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    const rel = file.slice(file.lastIndexOf("/tests/") + 1);
    if (!rel.startsWith("tests/") || rel.startsWith("tests/db/") || ALLOWED.includes(rel)) return {};
    const check = (node, source) => {
      if (typeof source === "string" && /(^|\/)store\/supabase(\/index)?(\.[cm]?[jt]sx?)?$/.test(source)) context.report({ node, messageId: "forbidden" });
    };
    return {
      ImportDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { if (node.source.type === "Literal") check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value); },
      ExportAllDeclaration(node) { check(node, node.source.value); },
    };
  },
};
