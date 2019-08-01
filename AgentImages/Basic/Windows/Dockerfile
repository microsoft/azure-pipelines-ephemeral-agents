FROM mcr.microsoft.com/windows/servercore:ltsc2019

WORKDIR /azp

COPY start-once.ps1 .
COPY start.ps1 .

CMD powershell .\start-once.ps1