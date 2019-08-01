#!/bin/bash

source ./constants.sh

nsgName=$vnetName-nsg

echo "creating resource group $vNetResourceGroup on $location"
az group create --resource-group $vNetResourceGroup --name $vNetResourceGroup --location $location > /dev/null

echo "creating nsg $nsgName for vnet $vnetName"

az network nsg create --resource-group $vNetResourceGroup --name "$nsgName" --location $location > /dev/null

# private vnet 64K addresses
echo "creating vnet $vnetName"
az network vnet create --resource-group $vNetResourceGroup --name $vnetName --address-prefix "10.10.0.0/16"  > /dev/null

# Compute vnet (2046)
echo "creating compute subnet"
az network vnet subnet create --resource-group $vNetResourceGroup --vnet-name $vnetName \
    --name compute --network-security-group "$nsgName" \
    --address-prefix "10.10.0.0/21" > /dev/null

# storage vnet (2046)
echo "creating storage subnet"
az network vnet subnet create --resource-group $vNetResourceGroup --vnet-name $vnetName \
    --name storage --network-security-group "$nsgName" \
    --address-prefix "10.10.8.0/21" > /dev/null

# data vnet (2046)
echo "creating data subnet"
az network vnet subnet create --resource-group $vNetResourceGroup --vnet-name $vnetName \
    --name data --network-security-group "$nsgName" \
    --address-prefix "10.10.16.0/21" > /dev/null

# Plenty of space to place more subnets if needed

# Bastion (510)
echo "creating  bastion subnet"
az network vnet subnet create --resource-group $vNetResourceGroup --vnet-name $vnetName \
    --name bastion --network-security-group "$nsgName" \
    --address-prefix "10.10.250.0/23" > /dev/null

# Agents (510)
echo "creating azure devops agents subnet"
az network vnet subnet create --resource-group $vNetResourceGroup --vnet-name $vnetName \
    --name $agentsSubNetName --network-security-group "$nsgName" \
    --address-prefix "10.10.254.0/23" > /dev/null


