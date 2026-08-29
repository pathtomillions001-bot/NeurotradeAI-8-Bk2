---
name: Settings cache key bug
description: The orval-generated useGetSettings hook uses ["/api/settings"] as its React Query key — not ["getSettings"].
---

## Rule
Always use `getGetSettingsQueryKey()` (imported from `@workspace/api-client-react`) when calling `queryClient.setQueryData` or `queryClient.invalidateQueries` after a settings save.

```ts
import { getGetSettingsQueryKey } from "@workspace/api-client-react";

// In onSuccess:
const settingsKey = getGetSettingsQueryKey(); // returns ["/api/settings"]
queryClient.setQueryData(settingsKey, saved);
queryClient.invalidateQueries({ queryKey: settingsKey });
```

**Why:** Using `["getSettings"]` or `["settings"]` creates a different cache entry. The `useGetSettings` hook reads from `["/api/settings"]`, so `setQueryData` with the wrong key doesn't update what the hook sees. The `useEffect([settings])` then re-runs with the OLD cached settings, silently overwriting the form with pre-save values — making contract-type selections (e.g. DIGITMATCH/DIGITDIFF) appear to disappear after saving.

**How to apply:** Any component that calls `useUpdateSettings()` and then needs to reflect the saved state immediately must use `getGetSettingsQueryKey()`, not a hand-written key string.
