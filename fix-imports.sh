#!/bin/bash
# Update imports from @repo/shadcn-ui/components/ui to @/components/ui
find src -type f -name "*.tsx" -exec sed -i 's|@repo/shadcn-ui/components/ui|@/components/ui|g' {} +
# Update imports from @repo/shadcn-ui/lib/utils to @/lib/utils
find src -type f -name "*.tsx" -exec sed -i 's|@repo/shadcn-ui/lib/utils|@/lib/utils|g' {} +
