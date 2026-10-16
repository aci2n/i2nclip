# Exclude editor artifacts from builds

Keep editor lock files (`.#*`), autosaves (`#*#`) and backups (`*~`) out of Git
and Docker/Podman build contexts at every directory depth. These files are not
application sources; a dangling lock symlink in sql/ makes SQLx fail before it
can read the migrations. Update both container ignore files consistently.

Do not delete active editor files, change migrations, or add runtime filtering.
The container build owns exclusion; local editor files retain their lifecycle.
Acceptance: build the server image with the existing SQL lock/autosave files
present, verify only the real migration reaches /src/sql, and commit the ignore
rules without the editor artifacts.
