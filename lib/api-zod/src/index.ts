export * from "./generated/api";
// The generated `types` folder mirrors every request/response schema as a TS
// type. A few names (e.g. `SwitchAccountBody`) collide with the zod schema
// consts of the same name in `./generated/api`, so the types are re-exported
// under the `types` namespace instead of a bare star export.
export * as types from "./generated/types";
