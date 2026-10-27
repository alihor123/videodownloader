@echo off
setlocal
cd /d "%~dp0.."

if not defined JAVA_HOME set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
for /d %%J in ("%USERPROFILE%\.gradle\jdks\*17*") do set "JAVA_HOME=%%~fJ"
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "NODE_ENV=production"

call npx expo prebuild --platform android
if errorlevel 1 exit /b 1

call android\gradlew.bat -p android :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -Pexpo.useLegacyPackaging=true "-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m" -Dorg.gradle.internal.http.connectionTimeout=120000 -Dorg.gradle.internal.http.socketTimeout=120000
if errorlevel 1 exit /b 1

if not exist build mkdir build
copy /Y android\app\build\outputs\apk\release\app-release.apk build\a4loader.apk >nul
if errorlevel 1 exit /b 1

echo APK: build\a4loader.apk
