# Run Loop as an independent local process

The shared Loop Service runs in an independent local Loop Host, while Pi Web is only a management adapter and Pi AgentSession is the Round execution adapter. Binding scheduling and dispatch to the Pi Web server would make the generic Loop capability unavailable to CLI/TUI users and would couple unattended execution to a UI lifecycle; the existing experimental `lib/loop` job model and its data/API compatibility are intentionally not preserved during replacement.
