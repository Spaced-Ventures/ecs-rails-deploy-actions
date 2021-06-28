// 1. Get VPCs and filter with the name
// 2. Get private Subnet ID
// 3. Get ECS task security group.
// 4. Run migratin ECS task
// 5. Poll Cloud watch event.
//    Fail : rake aborted!
//     StandardError: An error has occurred, this and all later migrations canceled:
// 6. Deploy Web API
// 7. Deploy Workers

const core = require("@actions/core");
const AWS = require("aws-sdk");

async function getEcsVpcDetail(ec2, params){
  const vpcs = await ec2.describeVpcs({
    Filters: [{ Name: 'tag:Name', Values: [params.vpc_tag]}]
  }).promise();

  const vpc = vpcs.Vpcs[0];
  const subnets = await ec2.describeSubnets({
    Filters: [ { Name: 'vpcId', Values: [vpc.VpcId]}]
  }).promise();

  const privateSubnets = subnets.Subnets.filter(s => s.MapPublicIpOnLaunch == false);

  const securityGroups = await ec2.describeSecurityGroups({
    Filters: [
      { Name: 'vpc-id', Values: [vpc.VpcId]},
      { Name: 'group-name', Values: [params.ecs_tag_security_group]}
    ]
  }).promise();

  const securityGroup = securityGroups.SecurityGroups[0];

  return {
    vpcId: vpc.VpcId,
    privateSubnetIds: privateSubnets.map(s => s.SubnetId),
    securityGroupId: securityGroup.GroupId,
  }
}

async function runDbMigrateTask(ecs, vpcDetail, params) {
  const {
    securityGroupId,
    privateSubnetIds,
  } = vpcDetail;
  const networkConfig = {
    awsvpcConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [securityGroupId],
      assignPublicIp: "DISABLED"
    }
  }
  const overrides = {
    containerOverrides: [{
      name: params.container
    }]
  }

  const tasks = await ecs.runTask({
    startedBy: 'db-migrate',
    taskDefinition: `${params.resource_prefix}-task-db-migrate`,
    launchType: 'FARGATE',
    cluster: params.cluster,
    networkConfiguration: networkConfig,
    overrides: overrides
  }).promise();
  const taskIds = tasks.tasks.map(t => t.taskArn.split('/').pop());

  core.debug('DB Migration task started');
  core.debug('Task Id :' + taskIds.join(', ') );

  await ecs.waitFor('tasksStopped', {
    tasks: taskIds,
    cluster: params.cluster
  }).promise();

  const cloudWatchLogs = new AWS.CloudWatchLogs({ region: params.region });

  const log = await cloudWatchLogs.getLogEvents({
    logGroupName: params.log_group,
    logStreamName: `dbmigrate/${params.container}/${taskIds[0]}`,
  }).promise();

  core.debug(log.events.map(e => e.message).join("\n"))

  const failedEvents = log.events.filter(e => e.message.includes('rake aborted'))

  if(failedEvents.length > 0){
     throw new Error("Migration failed: \n"  + log.events.map(e => e.message).join('\n'));
  }

  core.debug(`DB Migration Completed`);
}

async function deployServices(ecs, params){
  await ecs.updateService({
    service: params.api_service_task,
    cluster: params.cluster,
    forceNewDeployment: true
  }).promise();

  core.debug('API Service deployed');

  await ecs.updateService({
    service: params.worker_service_task,
    cluster: params.cluster,
    forceNewDeployment: true
  }).promise();

  core.debug('Worker Service deployed');
}

async function run() {
  const region = core.getInput("aws_region", { required: true });
  const resourcePrefix = core.getInput("aws_resource_prefix", { required: true });
  const params = {
      region,
      resource_prefix: resourcePrefix,
      vpc_tag: `${resourcePrefix}-vpc`,
      ecs_tag_security_group: `${resourcePrefix}-sg-ecs-tasks`,
      cluster: `${resourcePrefix}-cluster`,
      container: `${resourcePrefix}-container`,
      api_service_task: `${resourcePrefix}-api-ecs-service`,
      worker_service_task: `${resourcePrefix}-worker-ecs-service`,
      log_group: `${resourcePrefix}/ecs`
  }

  const ec2 = new AWS.EC2({ region: params.region });
  const ecs = new AWS.ECS({ region: params.region });

  try {
    const ecsVpcDetail = await getEcsVpcDetail(ec2, params);

    await runDbMigrateTask(ecs, ecsVpcDetail, params);
    await deployServices(ecs, params)
  }catch(error) {
    core.debug(error.stack);
    core.setFailed(error.message);
  }
}

module.exports = run;

if (require.main === module) {
  run();
}
