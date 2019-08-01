#!/bin/bash

source ./constants.sh

echo "creating resource group $resourceGroup on $location"
az group create --resource-group $resourceGroup --name $resourceGroup --location $location > /dev/null

echo "creating ACR $acrName"

az acr create --resource-group $resourceGroup --location $location \
    --name $acrName \
    --admin-enabled --sku basic > /dev/null