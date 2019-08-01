# Ephemeral Azure Pipelines agent image(s)

Basic docker images to run an ephemeral Azure Pipelines agent, these images are very basic and are intended to be used for a single execution. They have a very minimal set of software installed so they are not suitable for building code, their purpose is mainly to deploy code to your Azure Resources that are not exposed in the internet but only accessible through a private network so they are unreachable from [MS Hosted agents]

The images are setup to configure an Azure Pipelines Agent when the image is executed.

Only Azure DevOps Service has been tested, but this should work fine against Azure DevOps Server as well.

Those images are based on the scripts provided on [Running a self-hosted agent in Docker](https://docs.microsoft.com/en-us/azure/devops/pipelines/agents/docker?view=azure-devops) but have been adopted for the agent to run only once for a single use and then it self destructs. (before that it unregisters from the agent pool)

## Virtual Network

Since the purpose is to deploy to private resources that are not exposed on the internet, the ephemeral agent needs to have direct line of sight to the resources we intend do deploy to so they reside in the same virtual network has the resources.

![virtual network](../virtualnetworks.png)

## Linux

Besides the base OS image ([ubuntu 16.04](https://hub.docker.com/_/ubuntu), the following applications are installed

* curl
* jq
* git
* netcat
* wget
* Azure CLI
* PowerShell core

## Windows

The windows agent is based on [Windows server core](https://hub.docker.com/_/microsoft-windows-servercore) and doesn't has any extra software installed.

### Agent installation and configuration

When the image is executed, it automatically downloads the latest version of gthe Azure Pipelines agent, it registers as an agent and starts the agent to be executed *only* once.

After a job has been executed, the agent unregisters and (if) running inside an [Azure Container](https://azure.microsoft.com/en-us/product-categories/containers/) it also deletes the container. If you don't provide the necessary parameters for container deletion it will just stop by himself.

In order for the agent to function inside the machine the following parameters need to be passed to the image when executed

* **AZP_URL** The URL for your organization (eg: https://dev.azure.com/contoso)
* **AZP_POOL** The name of the pool where the agent is going to be registered (needs to exist).
* **AZP_AGENT_NAME** (optional) The agent name to be registered, if omitted the hostname will be used.
* **AZP_TOKEN** (secure if possible) The [personal access](https://docs.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops) or OAuth token used to register/unregister the agent. It requires that is has enough permissions to register and unregister agents
* **AZP_WORK** (optional) The work folder directory in case you want to control the agent work folder.

It is recommended to have one agent pool per team project and per virtual network (tuple).

In case you are running the image on [Azure Container Instances](https://azure.microsoft.com/en-in/services/container-instances/) you need to pass the following parameters for the container to be deleted after the job is executed. (this is optional)

* **AZ_ACI_NAME** The name of the container instance to be deleted
* **AZ_ACI_RG** The resource group where the container instance is located
* **AZ_MANAGED_IDENTITY** (true|false) If a managed identity is being used. At the time of the implementation Azure Container Instances cannot use managed identities with virtual networks, so using a managed identity is reserved for future use.
* **AZ_TENANT_ID** Azure Subscription Tenant Id (not necessary when using managed identity)
* **AZ_SUBSCRIPTION_ID** Azure Subscription identifier
* **AZ_CLOUD** The cloud environment being used (to be used to login on national clouds for example). By default _AzureCloud_ is assumed You can get the list of available clouds by running the command `az cloud list`
* **AZ_SERVICE_PRINCIPAL** (secure if possible) The service principal, it needs to have enough permissions on the azure container instance (or resource group) to delete the container. (not necessary when using managed identity)
* **AZ_SERVICE_PRINCIPAL_KEY** (secure if possible) The service principal key (not necessary when using managed identity)

For example you can create such a container in Azure Container Instance in a private network using the following script (it is assumed the image is store in Azure Container Registry).

Most variable values are omitted for brevity

```shell

acrName=contosoacr
imageName=$acrName.azurecr.io/basicagent:ubuntu-16.04
osType=Linux

agentSubnetId=$(az network vnet subnet show --resource-group $vNetResourceGroup \
    --name azure-devops-agents-subnet\
    --vnet-name $vnetName \
    --query id \
    --output tsv)


acrUser=`az acr credential show --output tsv --name $acrName --query username`
acrPassword=`az acr credential show --output tsv --name $acrName --query passwords[0].value`

az container create --name $agentname  \
        --resource-group $ResourceGroup --location $location \
        --image $imageName \
        --registry-username $acrUser \
        --registry-password $acrPassword \
        --ip-address private \
        --os-type $osType \
        --cpu 1 --memory 1 \
        --subnet $agentSubnetId \
        --restart-policy Never \
        --environment-variables AZP_URL=https://dev.azure.com/contoso \
            AZP_POOL=ephemeralPool \
            AZP_AGENT_NAME=$agentname \
        --secure-environment-variable  \
            AZP_TOKEN=$PersonalAccessToken

```

### Tokens

In order to register the agent a token with sufficient permissions on the Azure DevOps Organization the agent is going to be registered is needed.

You can use two different types of tokens.

#### Personal Access Token

If using a PAT, it requires _Agent Pools_ Read & Manage scope and that the user who owns the PAT has administration privileges on the agent pool you intend to register the agent.

Read more about the [necessary permissions to register an agent](https://docs.microsoft.com/en-us/azure/devops/pipelines/agents/agents?view=azure-devops#authentication)

You can read more about [agent pool permissions](https://docs.microsoft.com/en-us/azure/devops/pipelines/agents/pools-queues?view=azure-devops#security)

#### OAuth token

Personal Access Tokens work great, but they have a time limit and if the person that create the PAT leaves the organization or loses permission they stop working, so they need to be renewed and managed (if being used in an automated scenario).

If you are creating the container from an Azure Pipeline (the intended scenario, since we have provided a companion pipeline task for this) you can also use OAuth tokens (see [System.AccessToken](https://docs.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops&tabs=yaml#systemaccesstoken)) which are short lived (only) which is dynamic and short lived but automatically managed by the system.

If you want to use `System.Accestoken` you need to make sure the following conditions are met

* The timeout for the job that creates the image only expires after the job that is executed in the ephemeral agent (since the token is use to both register and unregister the agent).
* The account `Project Collection Build Service (<organization>)` (where <organization> is your organization name) needs to have the following permission
  * Administration permissions on the pool (see [agent pool permissions](https://docs.microsoft.com/en-us/azure/devops/pipelines/agents/pools-queues?view=azure-devops#security))
  * The permission is granted at the organization level not at the team project level.

## Adding software to the image

If you require more software on your ephemeral agents, you should build your images on top of the basic one instead of modifying the provided one (don't change start command file).

## Building the image(s)

This repo contains an Azure DevOps [YAML pipeline](azure-pipeline.yml) that creates an [Azure Container Registry](https://azure.microsoft.com/services/container-registry/), builds the docker image and pushes it to a Azure Container Registry.

The pipeline has two jobs, one for Linux and one for Windows. You need to add variables to your pipeline to define your Azure Container Registry and your Azure Subscription. You can add your own images to the jobs.

In order to use the pipeline you will need to create:

* An Azure Container Registry (the name of the registry needs to be unique, but the pipeline is not dependent on it)
* An [Azure Container Registry service connection](https://docs.microsoft.com/en-us/azure/devops/pipelines/library/service-endpoints?view=azure-devops&tabs=yaml#sep-docreg) with the name `PipelineAgentsImagesRegistry` or a name of your choosing (update the pipeline in case you used a different name).

The pipelines publishes two images:

* `$ACRNAME`.azurecr.io/azurepipelinesbasicdeployagent/linux:ubuntu-16.04
* `$ACRNAME`.azurecr.io/azurepipelinesbasicdeployagent/windows/servercore:ltsc2019

> where $ACRNAME is the name of the Azure Container Registry you configured in the service connection.

By default only the Linux image is built since Azure Container Instances preview don't support virtual networks in windows images. If you want to enable the job that builds the windows image, just change the value of the `buildWindowsImage` variable from false to true.

```yaml
variables:
-  buildLinuxImage: true
  buildWindowsImage: false
```

## Known Issues/limitations

Virtual networks are currently only supported for Linux images, peering is not supported  so the agents must be in the same virtual network as the resources it is deploying to.

You need a dedicated subnet for the agents, since only container instances can use it.

There are other limitations during the preview, see more at [Deploy container instances into an Azure virtual network preview limitations](https://docs.microsoft.com/en-us/azure/container-instances/container-instances-vnet#virtual-network-deployment-limitations).

For simplicity of the whole process, the agent is unregistered and the container is destroyed once the job is done, this cleanup is done by the container itself to it can fail. It is recommended to setup a scheduled procedure to delete stopped containers and remove stopped agents from the used pool(s) (eg: a nightly process).
