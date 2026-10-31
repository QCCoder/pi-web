# Use Workspace as the top-level product boundary

Pi Web currently groups sessions around a working directory or Git project, but the product needs one collaboration boundary to contain multiple repositories, work items, conversations, skills, and shared rules. Pi Workspace therefore makes Workspace the top-level boundary and treats repositories as children; a repository working copy cannot simultaneously belong to multiple Workspaces because conflicting rules and agent histories would make ownership ambiguous.
