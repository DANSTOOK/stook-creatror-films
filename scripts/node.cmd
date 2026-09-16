@echo off
rem Node, for a machine that has no Node.
rem
rem Electron ships the same runtime, and with ELECTRON_RUN_AS_NODE=1 its binary
rem behaves as node - which is how every script in this project is run here.
rem Tools that insist on a "node" command (the preview launcher, editors) can
rem point at this instead.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\node_modules\electron\dist\electron.exe" %*
