@echo off
setlocal
if not defined FACADE_H2_NODE exit /b 90
if not defined FACADE_H2_PI_RUNTIME exit /b 91
"%FACADE_H2_NODE%" "%FACADE_H2_PI_RUNTIME%" %*
exit /b %ERRORLEVEL%
