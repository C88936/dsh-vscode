---
name: skill-creator
description: Create or revise a DSH skill from a user's request. Choose a project or personal skill directory, write the instructions and required supporting files, then verify that DSH can load the skill.
---

# Create a DSH skill

Use the conversation to establish the workflow, the inputs it needs, and how the user will judge the result. When the user wants the skill across projects, use the active DSH personal skill directory. For project-specific conventions, use the current project's `.agents/skills` directory. Ask about the scope if it is unclear. Check the active host's paths before writing outside the workspace.

- Use a short, lowercase name separated by hyphens. Check for an existing skill with the same name before writing. For a revision, read the current skill and preserve instructions the user has not asked to change.
- Write `<name>/SKILL.md` with YAML frontmatter containing `name` and `description`. Use the description to distinguish when the skill applies. In the body, include the decisions, workflow, and output requirements that matter for that task.
- Add references, scripts, or templates when the workflow needs them. Use paths relative to the skill directory. Keep account credentials and private data out of the skill.
- Read the written files back. If the DSH `skill` tool is available, load the new skill by name and confirm that it resolves to the intended scope. Report the path and the `/<name>` command. If verification or writing is blocked, report the exact missing permission or unavailable path.

Update a personal skill when the user requests a durable change to that workflow. A conversation-specific correction can guide the current task without changing the saved skill.
