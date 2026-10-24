@echo off
setlocal
set "MULTIDSH_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%MULTIDSH_NODE%" (
  echo MultiDSH: bundled node.exe not found at "%MULTIDSH_NODE%" 1>&2
  exit /b 1
)
"%MULTIDSH_NODE%" %*
