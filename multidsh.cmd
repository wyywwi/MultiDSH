@echo off
rem Windows wrapper: .\multidsh.cmd init / start / status ...
setlocal
where node >nul 2>nul
if errorlevel 1 goto fallback
node "%~dp0multidsh" %*
exit /b %errorlevel%
:fallback
if exist "%~dp0bin\node.cmd" goto bundled
echo MultiDSH: 找不到 node。请先把 Node 24 加入 PATH，或使用仓库里的 bin\node.cmd。 1>&2
exit /b 1
:bundled
call "%~dp0bin\node.cmd" "%~dp0multidsh" %*
exit /b %errorlevel%
