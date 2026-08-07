# Keep Loop Definitions authoritative in Workspaces

Each Loop Definition and its owned configuration remain authoritative files inside its Workspace; the shared Loop Service keeps only a disposable Registry Index that can be rebuilt from trusted, registered Workspaces. A service-owned Loop database would simplify centralized queries but could drift from portable Workspace files, create two write paths, and make recovery or migration depend on hidden local state.
