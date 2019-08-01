#!/bin/bash

source ./constants.sh

echo "creating resource group $resourceGroup on $location"
az group create --resource-group $resourceGroup --name $resourceGroup --location $location > /dev/null

echo creating storage account $accountName in $resourceGroup resource group

az storage account create --name $accountName --resource-group $resourceGroup --location $location --https-only --kind StorageV2 --sku Standard_LRS > /dev/null

echo creating test container in $accountName

connectionString=$(az storage account show-connection-string --name $accountName --query connectionString --output tsv)

az storage container create --name test --auth-mode key --connection-string $connectionString  > /dev/null

echo restricting access to $agentsSubNetName subnet only

az storage account update --resource-group $resourceGroup --name $accountName --default-action Deny > /dev/null
az network vnet subnet update --resource-group $vNetResourceGroup  --vnet-name $vnetName --name azure-devops-agents --service-endpoints "Microsoft.Storage" > /dev/null

subnetid=$(az network vnet subnet show --resource-group $vNetResourceGroup --vnet-name $vnetName --name $agentsSubNetName --query id --output tsv)
az storage account network-rule add --resource-group $resourceGroup --account-name $accountName --subnet $subnetid > /dev/null