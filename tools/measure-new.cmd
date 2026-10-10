@echo off
rem 追加プレビューで入れた曲を測る。使い方: tools\measure-new.cmd <動画ID,動画ID,...>
rem （python は Microsoft Store の仮のものなので、.venv-embed を先に探させる）
cd /d %~dp0..
set PATH=%CD%\.venv-embed\Scripts;%PATH%
node tools\measure-intro.js
node tools\estimate-chorus.js
node tools\fetch-views.js
node tools\assign-fame.js
python tools\scan_videos.py --workers 1 --ids %1
echo 測定おわり
