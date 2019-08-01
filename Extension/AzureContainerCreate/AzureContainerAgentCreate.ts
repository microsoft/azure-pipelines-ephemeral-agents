// Code based on https://github.com/microsoft/azure-pipelines-tasks/tree/master/Tasks/AzureCLIV1
import { IExecSyncResult } from 'azure-pipelines-task-lib/toolrunner';
import { IExecSyncOptions } from 'azure-pipelines-task-lib/toolrunner';

import * as azdev from "azure-devops-node-api";
import * as taskAgentAPI from "azure-devops-node-api/TaskAgentApi"

import path = require("path");
import tl = require("azure-pipelines-task-lib");
import fs = require("fs");
import { TaskAgentPool, TaskAgentStatus, TaskGroupExpands } from 'azure-devops-node-api/interfaces/TaskAgentInterfaces';

export class azurecontainercreate {

    public static execSyncSilentOption = { silent: true } as IExecSyncOptions;

    public static checkIfAzurePythonSdkIsInstalled() {
        return !!tl.which("az", false);
    }

    public static async runMain() {
        var toolExecutionError = null;
        try {
            this.validateInputs();

            this.throwIfError(tl.execSync("az", "--version", this.execSyncSilentOption));

            var agentPoolName = tl.getInput("agentPool", true);

            this.throwIf(false === await this.agentPoolExists(agentPoolName, this.getToken()), tl.loc("InvalidAgentPool", agentPoolName))

            this.getRegistryCredentials();

            // set az cli config dir
            this.setConfigDirectory();
            this.setAzureCloudBasedOnServiceEndpoint();
            var connectedService: string = tl.getInput("connectedServiceNameARM", true);
            this.loginAzureRM(connectedService);

            this.createAgentContainer();

            if (false === await this.waitForAgentToBecomeOnline(this.agentPool, this.agentName, this.getToken())) {
                if (tl.getBoolInput("skipContainerDeletionOnError") === true) {
                    tl.warning(`Agent didn't come online. Skipping container and agent deletion.`);
                } else {
                    tl.warning(`Agent didn't come online. Going to delete container ${this.containerName}.`);
                    this.deleteAgentContainer();
                    this.deleteAgent(this.agentPool, this.agentName, this.getToken());
                }
                this.throwIf(true, tl.loc("WaitForAgentOnlineTimeout", this.agentName));
            }

            // Set output variables
            tl.setVariable('ImageNameOutput', this.containerName);
            tl.setVariable('ImageIdOutput', this.containerId);
        }
        catch (err) {
            if (err.stderr) {
                toolExecutionError = err.stderr;
            }
            else {
                toolExecutionError = err;
            }
            //go to finally and logout of azure and set task result
        }
        finally {

            if (this.cliPasswordPath) {
                tl.debug('Removing spn certificate file');
                tl.rmRF(this.cliPasswordPath);
            }

            //set the task result to either succeeded or failed based on error was thrown or not
            if (toolExecutionError) {
                tl.setResult(tl.TaskResult.Failed, tl.loc("ScriptFailed", toolExecutionError));
            }
            else {
                tl.setResult(tl.TaskResult.Succeeded, tl.loc("ScriptReturnCode", 0));
            }

            //Logout of Azure if logged in
            if (this.isLoggedIn) {
                this.logoutAzure();
            }
        }
    }

    private static isLoggedIn: boolean = false;
    private static cliPasswordPath: string = null;
    private static servicePrincipalId: string = null;
    private static servicePrincipalKey: string = null;
    private static tenantId: string = null;
    private static subscriptionId: string = null;
    private static cloudEnvironment: string = null;
    private static isManagedIdentity: boolean = false;


    private static agentPool: string;
    private static agentName: string = null;
    private static containerName: string = null;
    private static containerId: string = null;

    private static registryUsername: string = null;
    private static registryPassword: string = null;

    private static getToken() {
        return tl.getInput("azureDevOpsToken", true);
    }

    private static validateInputs() {

        // Validate vnet. If subnetmame is specified them vnet is also mandatory
        var subnetName = tl.getInput("subnetName");

        if (subnetName) {
            this.throwIf(tl.getInput("vnetName") === null, tl.loc("VnetMandatoryWithSubnet"));
        }

        var taskJSON: string = fs.readFileSync(path.join(__dirname, "task.json"), 'utf8');

        var taskObject = JSON.parse(taskJSON);

        var missingRequiredParameters = "";

        for (let input of taskObject.inputs) {
            if (input.required === true && input.type.indexOf(":") === -1) {
                if (null === tl.getInput(input.name, false)) {
                    missingRequiredParameters += `${input.name} `;
                }
            }
        }

        this.throwIf("" !== missingRequiredParameters, tl.loc("MissingRequiredInputs", missingRequiredParameters));
    }

    private static getRegistryCredentials(): void {
        let registryService = tl.getInput("containerRegistry");

        if (registryService !== null) {

            var registryType = tl.getEndpointDataParameter(registryService, "registrytype", true);

            if (registryType === "ACR") {
                tl.debug("Using ACR");

                this.registryUsername = tl.getEndpointAuthorizationParameter(registryService, 'serviceprincipalid', true);
                this.registryPassword = tl.getEndpointAuthorizationParameter(registryService, 'serviceprincipalkey', true);
            } else {
                tl.debug("Using generic authenticated registry");
                this.registryUsername = tl.getEndpointAuthorizationParameter(registryService, 'username', true);
                this.registryPassword = tl.getEndpointAuthorizationParameter(registryService, 'password', true);
            }
        } else {
            tl.debug("not using an authenticated registry");
        }
    }

    private static getSubNetId(): string {
        var vnetResourceGroup = tl.getInput("vnetResourceGroupName", false);
        var subnetName = tl.getInput("subnetName", false);

        if (subnetName === null) {
            tl.debug("Not using a subnet for container.")
            return null;
        }
        var vnetName = tl.getInput("vnetName", true);

        // If no vnet resource group was specified than use the agent resource group
        if (vnetResourceGroup === null) {
            vnetResourceGroup = tl.getInput("resourceGroupName", true);
        }

        tl.debug(`looking for subnet ${subnetName} in vnet ${vnetName} in rg ${vnetResourceGroup}`)

        let getVnetResult = tl.execSync("az",
            "network vnet subnet show --resource-group \"" + vnetResourceGroup + "\" --name \"" + subnetName + "\" --vnet-name \"" + vnetName + "\" --output json",
            this.execSyncSilentOption);

        this.throwIfError(getVnetResult, tl.loc("GetSubnetFailed", subnetName, vnetName, vnetResourceGroup));

        var subnetObject = JSON.parse(getVnetResult.stdout);
        var subnetId = subnetObject.id;

        tl.debug("Using subnetId " + subnetId)

        return subnetId;
    }

    private static async deleteAgent(agentPoolName: string, agentName: string, token?: string) {
        if (token === null) {
            token = tl.getVariable("SYSTEM_ACCESSTOKEN");
        }

        var taskAgent = await this.getTaskAgentAPI(token);

        let agentPool: TaskAgentPool[] = await taskAgent.getAgentPools(agentPoolName);

        var agentPoolId = agentPool[0].id;

        let agents = await taskAgent.getAgents(agentPoolId, agentName, false, false, false);

        if (agents === null || agents.length === 0) {
            tl.debug("No agent to delete.");
        } else {
            var agentId = agents[0].id;

            console.log(`deleting agent ${agentId} from pool ${agentPoolId}`);

            taskAgent.deleteAgent(agentPool[0].id, agentId);
        }
    }

    private static deleteAgentContainer() {
        var azTool = tl.tool(tl.which("az", true));

        var resourceGroup = tl.getInput("ResourceGroupName", true);

        tl.debug(`deleting ${this.agentName} in rg ${resourceGroup}`)

        azTool
            .arg(["container", "delete", "--yes"])
            .arg(["--name", this.containerName])
            .arg(["--resource-group", resourceGroup]);

        var deletionResult = azTool.execSync(this.execSyncSilentOption);

        tl.debug("delete container returned " + deletionResult.code);

        if (deletionResult.code !== 0) {
            tl.warning("Failed to delete container " + deletionResult.error);
        }
    }

    private static createAgentContainer() {
        var azTool = tl.tool(tl.which("az", true));

        var resourceGroup = tl.getInput("ResourceGroupName", true);
        var location = tl.getInput("location", true);
        var agentPrefix = tl.getInput("agentPrefix", false) || "";
        var imageName = tl.getInput("imageName");
        var agentPool = tl.getInput('agentPool', true);
        var osType = tl.getInput("osType", true);
        var cpu = tl.getInput("CPU", false) || "1";
        var memory = tl.getInput("memory", false) || "1.0";

        var addSPNToContainer = tl.getBoolInput("addSPNToContainer");

        var token = tl.getInput("azureDevOpsToken", true);

        var currentDate = new Date();

        var uniqueId = (tl.getVariable("Build_BuildId") || "") + (tl.getVariable("Release_ReleaseId") || "");

        var agentName = agentPrefix.toLowerCase() + `${uniqueId}${currentDate.getFullYear()}${currentDate.getMonth()}${currentDate.getDay()}${currentDate.getHours()}${currentDate.getMinutes()}${currentDate.getSeconds()}`
        var containerName = agentName;

        this.agentName = agentName;
        this.containerName = containerName;
        this.agentPool = agentPool;

        console.log(`Creating container/agent ${agentName} with image ${imageName}` );

        var subnetId = this.getSubNetId();

        azTool
            .arg(["container", "create"])
            .arg(["--name", containerName])
            .arg(["--resource-group", resourceGroup])
            .arg(["--location", location])
            .arg(["--image", imageName])
            .arg(["--ip-address", "private"])
            .arg(["--os-type", osType])
            .arg(["--cpu", cpu])
            .arg(["--memory", memory])
            .arg(["--restart-policy", "Never"])
            .argIf(subnetId !== null, ["--subnet", subnetId])
            .arg(["--environment-variables",
                `AZP_URL=${tl.getVariable("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI")}`,
                `AZP_POOL=${agentPool}`,
                `AZP_AGENT_NAME=${agentName}`])
            .argIf(addSPNToContainer, [
                `AZ_ACI_NAME=${containerName}`,
                `AZ_ACI_RG=${resourceGroup}`,
                `AZ_TENANT_ID=${this.tenantId}`,
                `AZ_SUBSCRIPTION_ID=${this.subscriptionId}`,
                `AZ_MANAGED_IDENTITY=${this.isManagedIdentity}`,
                `AZ_CLOUD=${this.cloudEnvironment}`
            ])
            .arg(["--secure-environment-variables", `AZP_TOKEN=${token}`])
            .argIf(addSPNToContainer, [
                `AZ_SERVICE_PRINCIPAL=${this.servicePrincipalId}`,
                `AZ_SERVICE_PRINCIPAL_KEY=${this.servicePrincipalKey}`
            ])
            .argIf(this.registryUsername !== null, ["--registry-username", this.registryUsername])
            .argIf(this.registryUsername !== null, ["--registry-password", this.registryPassword])
            .arg(["--output","json"]);

        var creationResult = azTool.execSync(this.execSyncSilentOption);

        this.throwIfError(creationResult,tl.loc("FailedContainerCreation"));

        var creationObject = JSON.parse(creationResult.stdout);

        this.containerId = creationObject.id;
    }

    private static async getTaskAgentAPI(token: string, organizationUrl?: string): Promise<taskAgentAPI.ITaskAgentApi> {

        organizationUrl = organizationUrl || tl.getVariable("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI");

        let authHandler = azdev.getPersonalAccessTokenHandler(token);
        let connection = new azdev.WebApi(organizationUrl, authHandler);
        let taskAgent: taskAgentAPI.ITaskAgentApi = await connection.getTaskAgentApi();

        return taskAgent;
    }

    private static async agentPoolExists(agentPoolName: string, token?: string): Promise<boolean> {
        let taskAgent = await this.getTaskAgentAPI(token);

        console.log(`Checking if ${agentPoolName} pool exists`);

        if (token === null) {
            token = tl.getVariable("SYSTEM_ACCESSTOKEN");
        }

        let agentPool: TaskAgentPool[] = await taskAgent.getAgentPools(agentPoolName);

        return agentPool !== null && agentPool.length === 1 && agentPool[0].name.toLowerCase() === agentPoolName.toLowerCase();
    }

    private static async waitForAgentToBecomeOnline(agentPoolName: string, agentName: string, token?: string): Promise<boolean> {
        var maxWaitTime = tl.getInput("timeoutAgentOnline", false) || 240;

        if (maxWaitTime === 0) {
            tl.warning("Skipping check if agent is online");
            return true;
        }

        if (token === null) {
            token = tl.getVariable("SYSTEM_ACCESSTOKEN");
        }

        tl.debug(`wait time for agent to become online ${maxWaitTime}`);

        var startTime = new Date();

        var taskAgent = await this.getTaskAgentAPI(token);

        let agentPool: TaskAgentPool[] = await taskAgent.getAgentPools(agentPoolName);
        this.throwIf(agentPool === null || agentPool.length === 0, tl.loc("InvalidAgentPool", agentPoolName));

        var agentPoolId = agentPool[0].id;

        tl.debug("Agentpoold id " + agentPoolId);

        console.log(`checking if ${agentName} is online in agent pool ${agentPoolName} (ID: ${agentPoolId})`);

        while (((new Date().getTime() - startTime.getTime()) / 1000 <= maxWaitTime)) {

            tl.debug("checking agent status");
            let agents = await taskAgent.getAgents(agentPoolId, agentName, false, false, false);

            if (agents !== null && agents.length > 0) {
                if (agents[0].status === TaskAgentStatus.Online) {
                    console.log(`Agent ${agentName} is online. Continuing`);
                    return true;
                }
                tl.debug("Agent status" + agents[0].status);
            }

            console.log("Sleeping before checking status again.");
            await this.sleepFor(8);
        }

        return false;
    }

    private static sleepFor(sleepDurationInSeconds): Promise<any> {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }

    private static loginAzureRM(connectedService: string): void {
        var authScheme: string = tl.getEndpointAuthorizationScheme(connectedService, true);
        var subscriptionID: string = tl.getEndpointDataParameter(connectedService, "SubscriptionID", true);
        var tenantId: string = tl.getEndpointAuthorizationParameter(connectedService, "tenantid", false);

        this.subscriptionId = subscriptionID;
        this.tenantId = tenantId;

        if (authScheme.toLowerCase() == "serviceprincipal") {
            let authType: string = tl.getEndpointAuthorizationParameter(connectedService, 'authenticationType', true);
            let cliPassword: string = null;
            var servicePrincipalId: string = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalid", false);

            this.servicePrincipalId = servicePrincipalId;

            if (authType == "spnCertificate") {
                tl.debug('certificate based endpoint');
                let certificateContent: string = tl.getEndpointAuthorizationParameter(connectedService, "servicePrincipalCertificate", false);
                cliPassword = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory'), 'spnCert.pem');
                fs.writeFileSync(cliPassword, certificateContent);
                this.cliPasswordPath = cliPassword;
            }
            else {
                tl.debug('key based endpoint');
                cliPassword = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalkey", false);
                this.servicePrincipalKey = cliPassword;
            }

            //login using svn
            this.throwIfError(tl.execSync("az",
                "login --service-principal -u \"" + servicePrincipalId + "\" -p \"" + cliPassword + "\" --tenant \"" + tenantId + "\""),
                tl.loc("LoginFailed"));
        }
        else if (authScheme.toLowerCase() == "managedserviceidentity") {
            //login using msi
            this.throwIfError(tl.execSync("az", "login --identity", this.execSyncSilentOption), tl.loc("MSILoginFailed"));
            this.isManagedIdentity = true;
        }
        else {
            throw tl.loc('AuthSchemeNotSupported', authScheme);
        }

        this.isLoggedIn = true;
        //set the subscription imported to the current subscription
        this.throwIfError(tl.execSync("az", "account set --subscription \"" + subscriptionID + "\"", this.execSyncSilentOption), tl.loc("ErrorInSettingUpSubscription"));
    }

    private static setConfigDirectory(): void {
        if (tl.getBoolInput("useGlobalConfig")) {
            return;
        }

        if (!!tl.getVariable('Agent.TempDirectory')) {
            var azCliConfigPath = path.join(tl.getVariable('Agent.TempDirectory'), ".azclitask");
            console.log(tl.loc('SettingAzureConfigDir', azCliConfigPath));
            process.env['AZURE_CONFIG_DIR'] = azCliConfigPath;
        } else {
            console.warn(tl.loc('GlobalCliConfigAgentVersionWarning'));
        }
    }

    private static setAzureCloudBasedOnServiceEndpoint(): void {
        var connectedService: string = tl.getInput("connectedServiceNameARM", true);
        var environment = tl.getEndpointDataParameter(connectedService, 'environment', true);
        if (!!environment) {
            console.log(tl.loc('SettingAzureCloud', environment));
            this.throwIfError(tl.execSync("az", "cloud set -n " + environment, this.execSyncSilentOption));

            this.cloudEnvironment = environment;
        }
    }

    private static logoutAzure() {
        tl.debug("logoutAzure");
        try {
            tl.execSync("az", " account clear", this.execSyncSilentOption);
        }
        catch (err) {
            // task should not fail if logout doesn`t occur
            tl.warning(tl.loc("FailedToLogout"));
        }
    }


    private static throwIf(isError: boolean, errormsg?: string): void {
        if (isError) {
            if (errormsg) {
                tl.error("Error: " + errormsg);
            }
            throw "error";
        }
    }

    private static throwIfError(resultOfToolExecution: IExecSyncResult, errormsg?: string): void {
        if (resultOfToolExecution.code != 0) {
            tl.error("Error Code: [" + resultOfToolExecution.code + "]");
            if (errormsg) {
                tl.error("Error: " + errormsg);
            }
            throw resultOfToolExecution;
        }
    }
}

tl.setResourcePath(path.join(__dirname, "task.json"));

if (!azurecontainercreate.checkIfAzurePythonSdkIsInstalled()) {
    tl.setResult(tl.TaskResult.Failed, tl.loc("AzureSDKNotFound"));
}

azurecontainercreate.runMain();
