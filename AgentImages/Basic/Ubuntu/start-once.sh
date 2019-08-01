#!/bin/bash
set -e

if [ -z "$AZP_URL" ]; then
  echo 1>&2 "error: missing AZP_URL environment variable"
  exit 1
fi

if [ -z "$AZP_TOKEN_FILE" ]; then
  if [ -z "$AZP_TOKEN" ]; then
    echo 1>&2 "error: missing AZP_TOKEN environment variable"
    exit 1
  fi

  AZP_TOKEN_FILE=/azp/.token
  echo -n $AZP_TOKEN > "$AZP_TOKEN_FILE"
fi

unset AZP_TOKEN

if [ -n "$AZP_WORK" ]; then
  mkdir -p "$AZP_WORK"
fi

rm -rf /azp/agent
mkdir /azp/agent
cd /azp/agent

export AGENT_ALLOW_RUNASROOT="1"

cleanup() {
  if [ -e config.sh ]; then
    retry=1

    while [ $retry -lt 5 ]
    do
      print_header "Cleanup. Removing Azure Pipelines agent. Try $retry"

      ./config.sh remove --unattended \
        --auth PAT \
        --token $(cat "$AZP_TOKEN_FILE")

      if [ $? -eq 0 ]; then
        retry=999
      else
        print_header "Cleanup failed with code $?. sleeping before retrying"

        $retry=$[$retry+1]
        sleep 30
      fi
    done
  fi
}

print_header() {
  # lightcyan='\033[1;36m'
  # nocolor='\033[0m'
  # echo -e "${lightcyan}$1${nocolor}"
  echo -e "$1"
}

# Let the agent ignore the token env variables
export VSO_AGENT_IGNORE=VSO_AGENT_IGNORE,AZP_TOKEN,AZP_TOKEN_FILE,AZ_IS_MANAGED,AZ_ACI_NAME,AZ_ACI_RG,AZ_SERVICE_PRINCIPAL,AZ_SERVICE_PRINCIPAL_KEY,AZ_TENANT_ID,AZ_SUBSCRIPTION_ID,AZ,AZ_AGENT_NAME,AZP_POOL,AZP_URL,OLDPWD

print_header "1. Determining matching Azure Pipelines agent..."

AZP_AGENT_RESPONSE=$(curl -LsS \
  -u user:$(cat "$AZP_TOKEN_FILE") \
  -H 'Accept:application/json;api-version=3.0-preview' \
  "$AZP_URL/_apis/distributedtask/packages/agent?platform=linux-x64")

if echo "$AZP_AGENT_RESPONSE" | jq . >/dev/null 2>&1; then
  AZP_AGENTPACKAGE_URL=$(echo "$AZP_AGENT_RESPONSE" \
    | jq -r '.value | map([.version.major,.version.minor,.version.patch,.downloadUrl]) | sort | .[length-1] | .[3]')
fi

if [ -z "$AZP_AGENTPACKAGE_URL" -o "$AZP_AGENTPACKAGE_URL" == "null" ]; then
  echo 1>&2 "error: could not determine a matching Azure Pipelines agent - check that account '$AZP_URL' is correct and the token is valid for that account"
  exit 1
fi

print_header "2. Downloading $AZP_AGENTPACKAGE_URL and installing Azure Pipelines agent..."

curl -LsS $AZP_AGENTPACKAGE_URL | tar -xz & wait $!

source ./env.sh

trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

print_header "3. Configuring Azure Pipelines agent..."

./config.sh --unattended \
  --agent "${AZP_AGENT_NAME:-$(hostname)}" \
  --url "$AZP_URL" \
  --auth PAT \
  --token $(cat "$AZP_TOKEN_FILE") \
  --pool "${AZP_POOL:-Default}" \
  --work "${AZP_WORK:-_work}" \
  --replace \
--acceptTeeEula & wait $!

print_header "6. Patching listener..."

cp ../patches/AgentService.js ./bin/

print_header "5. Running Azure Pipelines agent..."

# `exec` the node runtime so it's aware of TERM and INT signals
# AgentService.js understands how to handle agent self-update and restart
./externals/node/bin/node ./bin/AgentService.js interactive --once

print_header "6. Removing Azure Pipelines agent..."

cleanup

print_header "7. Agent has been cleaned up..."

# Set default cloud
AZ_CLOUD=${AZ_CLOUD:-AzureClou2}

# Kill ourselves if running in ACI. 
if [ -n "$AZ_ACI_NAME" ]; then
  print_header "8. Destroying container $AZ_ACI_NAME on $AZ_ACI_RG resource group"
  print_header "8.1 Logging in with $AZ_SERVICE_PRINCIPAL on $AZ_CLOUD"
  az cloud set -n $AZ_CLOUD
  az login --service-principal \
    -u $AZ_SERVICE_PRINCIPAL \
    -p $AZ_SERVICE_PRINCIPAL_KEY \
    --tenant $AZ_TENANT_ID > /dev/null
  print_header "8.2 Setting Subscription $AZ_SUBSCRIPTION_ID"
  az account set --subscription $AZ_SUBSCRIPTION_ID > /dev/null
  print_header "8.3 Deleting "
  az container delete --yes \
    --resource-group $AZ_ACI_RG \
    --name $AZ_ACI_NAME
fi
