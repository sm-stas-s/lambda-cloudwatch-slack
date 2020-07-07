var AWS = require('aws-sdk');
var url = require('url');
var https = require('https');
var config = require('./config');
var _ = require('lodash');
var hookUrl;

AWS.config.update({region: 'us-east-1'});
var ec2 = new AWS.EC2({apiVersion: '2016-11-15'});

var awsDataReservations = [];
async function loadAwsData() {
  return new Promise((resolve, reject) => {
    ec2.describeInstances({
      DryRun: false
    }, function (err, data) {
      if (err) {
        reject(err.stack);
      } else {
        awsDataReservations = data.Reservations;
        resolve(data.Reservations);
      }
    })
  })
}

/**
 * @param {Object} slackMessage
 * @param {Object} message
 */
async function extendNotification(slackMessage, message) {
  await loadAwsData();
  const MessageDimension = _.get(message, 'Trigger.Dimensions');

  if (Array.isArray(MessageDimension)) {
    const instanceIds = MessageDimension.reduce((acc, messageDimension) => {
      if (messageDimension.name === 'InstanceId') {
        acc.push(messageDimension.value);
      }
      return acc;
    }, []);

    if (instanceIds.length > 0) {
      instanceIds.forEach(instanceId => {
        const instanceData = getInstanceById(instanceId);
        const section = {
          title: 'Instance',
          value: instanceData.InstanceName + "\n"
              + instanceData.PublicIpAddress + "\n"
              + `<https://console.aws.amazon.com/ec2/v2/home?region=us-east-1#Instances:search=${instanceData.InstanceId};sort=tag:Name|${instanceData.InstanceId}>`,
          short: false
        };
        slackMessage.attachments[0].fields.splice(1, 0, section);
      });
    }
  }
  return slackMessage;
}

/**
 * @async
 * @param {String} instanceId - i-007fb122f47e7a8f1 as example
 * @return {{
 *     InstanceId:String,
 *     PublicIpAddress:String,
 *     InstanceName:String,
 * }}
 */
function getInstanceById(instanceId) {
    var result = {
        InstanceId: instanceId,
        PublicIpAddress: 'Unclassified PublicIpAddress',
        InstanceName: 'Unclassified InstanceName',
    }

    const instanceData = awsDataReservations.reduce((acc, Reservation) => {
        const Instances = Reservation.Instances;
        const targetInstance = Instances.find(Instance => Instance.InstanceId === instanceId);
        if (targetInstance) {
            const instanceNameTag = targetInstance.Tags.find(Tag => Tag.Key === 'Name');
            const result = {
                InstanceId: targetInstance.InstanceId,
                PublicIpAddress: targetInstance.PublicIpAddress,
                InstanceName: instanceNameTag.Value || 'Unclassified'
            }

            acc.push(result);
        }
        return acc;
    }, []);

    if (instanceData.length === 1) {
        result = instanceData[0];
    }

    return result;
}

var baseSlackMessage = {}

var postMessage = function(message, callback) {
  var body = JSON.stringify(message);
  var options = url.parse(hookUrl);
  options.method = 'POST';
  options.headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };

  var postReq = https.request(options, function(res) {
    var chunks = [];
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      return chunks.push(chunk);
    });
    res.on('end', function() {
      var body = chunks.join('');
      if (callback) {
        callback({
          body: body,
          statusCode: res.statusCode,
          statusMessage: res.statusMessage
        });
      }
    });
    return res;
  });

  postReq.write(body);
  postReq.end();
};

var handleElasticBeanstalk = function(event, context) {
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var subject = event.Records[0].Sns.Subject || "AWS Elastic Beanstalk Notification";
  var message = event.Records[0].Sns.Message;

  var stateRed = message.indexOf(" to RED");
  var stateSevere = message.indexOf(" to Severe");
  var butWithErrors = message.indexOf(" but with errors");
  var noPermission = message.indexOf("You do not have permission");
  var failedDeploy = message.indexOf("Failed to deploy application");
  var failedConfig = message.indexOf("Failed to deploy configuration");
  var failedQuota = message.indexOf("Your quota allows for 0 more running instance");
  var unsuccessfulCommand = message.indexOf("Unsuccessful command execution");

  var stateYellow = message.indexOf(" to YELLOW");
  var stateDegraded = message.indexOf(" to Degraded");
  var stateInfo = message.indexOf(" to Info");
  var removedInstance = message.indexOf("Removed instance ");
  var addingInstance = message.indexOf("Adding instance ");
  var abortedOperation = message.indexOf(" aborted operation.");
  var abortedDeployment = message.indexOf("some instances may have deployed the new application version");

  var color = "good";

  if (stateRed != -1 || stateSevere != -1 || butWithErrors != -1 || noPermission != -1 || failedDeploy != -1 || failedConfig != -1 || failedQuota != -1 || unsuccessfulCommand != -1) {
    color = "danger";
  }
  if (stateYellow != -1 || stateDegraded != -1 || stateInfo != -1 || removedInstance != -1 || addingInstance != -1 || abortedOperation != -1 || abortedDeployment != -1) {
    color = "warning";
  }

  var slackMessage = {
    text: "*" + subject + "*",
    attachments: [
      {
        "fields": [
          { "title": "Subject", "value": event.Records[0].Sns.Subject, "short": false},
          { "title": "Message", "value": message, "short": false}
        ],
        "color": color,
        "ts":  timestamp
      }
    ]
  };

  return _.merge(slackMessage, baseSlackMessage);
};

var handleCodeDeploy = function(event, context) {
  var subject = "AWS CodeDeploy Notification";
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var snsSubject = event.Records[0].Sns.Subject;
  var message;
  var fields = [];
  var color = "warning";

  try {
    message = JSON.parse(event.Records[0].Sns.Message);

    if(message.status === "SUCCEEDED"){
      color = "good";
    } else if(message.status === "FAILED"){
      color = "danger";
    }
    fields.push({ "title": "Message", "value": snsSubject, "short": false });
    fields.push({ "title": "Deployment Group", "value": message.deploymentGroupName, "short": true });
    fields.push({ "title": "Application", "value": message.applicationName, "short": true });
    fields.push({
      "title": "Status Link",
      "value": "https://console.aws.amazon.com/codedeploy/home?region=" + message.region + "#/deployments/" + message.deploymentId,
      "short": false
    });
  }
  catch(e) {
    color = "good";
    message = event.Records[0].Sns.Message;
    fields.push({ "title": "Message", "value": snsSubject, "short": false });
    fields.push({ "title": "Detail", "value": message, "short": false });
  }


  var slackMessage = {
    text: "*" + subject + "*",
    attachments: [
      {
        "color": color,
        "fields": fields,
        "ts": timestamp
      }
    ]
  };

  return _.merge(slackMessage, baseSlackMessage);
};

var handleCodePipeline = function(event, context) {
  var subject = "AWS CodePipeline Notification";
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var snsSubject = event.Records[0].Sns.Subject;
  var message;
  var fields = [];
  var color = "warning";
  var changeType = "";

  try {
    message = JSON.parse(event.Records[0].Sns.Message);
    detailType = message['detail-type'];

    if(detailType === "CodePipeline Pipeline Execution State Change"){
      changeType = "";
    } else if(detailType === "CodePipeline Stage Execution State Change"){
      changeType = "STAGE " + message.detail.stage;
    } else if(detailType === "CodePipeline Action Execution State Change"){
      changeType = "ACTION";
    }

    if(message.detail.state === "SUCCEEDED"){
      color = "good";
    } else if(message.detail.state === "FAILED"){
      color = "danger";
    }
    header = message.detail.state + ": CodePipeline " + changeType;
    fields.push({ "title": "Message", "value": header, "short": false });
    fields.push({ "title": "Pipeline", "value": message.detail.pipeline, "short": true });
    fields.push({ "title": "Region", "value": message.region, "short": true });
    fields.push({
      "title": "Status Link",
      "value": "https://console.aws.amazon.com/codepipeline/home?region=" + message.region + "#/view/" + message.detail.pipeline,
      "short": false
    });
  }
  catch(e) {
    color = "good";
    message = event.Records[0].Sns.Message;
    header = message.detail.state + ": CodePipeline " + message.detail.pipeline;
    fields.push({ "title": "Message", "value": header, "short": false });
    fields.push({ "title": "Detail", "value": message, "short": false });
  }


  var slackMessage = {
    text: "*" + subject + "*",
    attachments: [
      {
        "color": color,
        "fields": fields,
        "ts": timestamp
      }
    ]
  };

  return _.merge(slackMessage, baseSlackMessage);
};

var handleElasticache = function(event, context) {
  var subject = "AWS ElastiCache Notification"
  var message = JSON.parse(event.Records[0].Sns.Message);
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var region = event.Records[0].EventSubscriptionArn.split(":")[3];
  var eventname, nodename;
  var color = "good";

  for(key in message){
    eventname = key;
    nodename = message[key];
    break;
  }
  var slackMessage = {
    text: "*" + subject + "*",
    attachments: [
      {
        "color": color,
        "fields": [
          { "title": "Event", "value": eventname.split(":")[1], "short": true },
          { "title": "Node", "value": nodename, "short": true },
          {
            "title": "Link to cache node",
            "value": "https://console.aws.amazon.com/elasticache/home?region=" + region + "#cache-nodes:id=" + nodename + ";nodes",
            "short": false
          }
        ],
        "ts": timestamp
      }
    ]
  };
  return _.merge(slackMessage, baseSlackMessage);
};

var handleCloudWatch = async function(event, context) {
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var message = JSON.parse(event.Records[0].Sns.Message);
  var region = event.Records[0].EventSubscriptionArn.split(":")[3];
  var alarmName = message.AlarmName;
  var metricName = message.Trigger.MetricName;
  var oldState = message.OldStateValue;
  var newState = message.NewStateValue;
  var alarmDescription = message.AlarmDescription;
  var alarmReason = message.NewStateReason;
  var trigger = message.Trigger;
  var color = "warning";

  if (message.NewStateValue === "ALARM") {
      color = "danger";
  } else if (message.NewStateValue === "OK") {
      color = "good";
  }

  var slackMessage = {
    text: "",
    attachments: [
      {
        "color": color,
        "fields": [
          { "title": "Alarm Name", "value": alarmName, "short": true },
          // will be inserted Instance data
          { "title": "Alarm Description", "value": alarmDescription, "short": false},
          {
            "title": "Trigger",
            "value": trigger.Statistic + " "
              + metricName + " "
              + trigger.ComparisonOperator + " "
              + trigger.Threshold + " for "
              + trigger.EvaluationPeriods + " period(s) of "
              + trigger.Period + " seconds.",
              "short": false
          },
          { "title": "Old State", "value": oldState, "short": true },
          { "title": "Current State", "value": newState, "short": true },
          {
            "title": "Link to Alarm",
            "value": "https://console.aws.amazon.com/cloudwatch/home?region=" + region + "#alarm:alarmFilter=ANY;name=" + encodeURIComponent(alarmName),
            "short": false
          }
        ],
        "ts":  timestamp
      }
    ]
  };

  try {
    slackMessage = await extendNotification(slackMessage, message);
  } catch (e) {
    console.log('Error of extend slackMessage', e);
  }

  return _.merge(slackMessage, baseSlackMessage);
};

var handleAutoScaling = function(event, context) {
  var subject = "AWS AutoScaling Notification"
  var message = JSON.parse(event.Records[0].Sns.Message);
  var timestamp = (new Date(event.Records[0].Sns.Timestamp)).getTime()/1000;
  var eventname, nodename;
  var color = "good";

  for(key in message){
    eventname = key;
    nodename = message[key];
    break;
  }
  var slackMessage = {
    text: "*" + subject + "*",
    attachments: [
      {
        "color": color,
        "fields": [
          { "title": "Message", "value": event.Records[0].Sns.Subject, "short": false },
          { "title": "Description", "value": message.Description, "short": false },
          { "title": "Event", "value": message.Event, "short": false },
          { "title": "Cause", "value": message.Cause, "short": false }

        ],
        "ts": timestamp
      }
    ]
  };
  return _.merge(slackMessage, baseSlackMessage);
};

var handleCatchAll = function(event, context) {

    var record = event.Records[0]
    var subject = record.Sns.Subject
    var timestamp = new Date(record.Sns.Timestamp).getTime() / 1000;
    var message = JSON.parse(record.Sns.Message)
    var color = "warning";

    if (message.NewStateValue === "ALARM") {
        color = "danger";
    } else if (message.NewStateValue === "OK") {
        color = "good";
    }

    // Add all of the values from the event message to the Slack message description
    var description = ""
    for(key in message) {

        var renderedMessage = typeof message[key] === 'object'
                            ? JSON.stringify(message[key])
                            : message[key]

        description = description + "\n" + key + ": " + renderedMessage
    }

    var slackMessage = {
        text: "*" + subject + "*",
        attachments: [
          {
            "color": color,
            "fields": [
              { "title": "Message", "value": record.Sns.Subject, "short": false },
              { "title": "Description", "value": description, "short": false }
            ],
            "ts": timestamp
          }
        ]
    }

  return _.merge(slackMessage, baseSlackMessage);
}

var processEvent = async function(event, context) {
  console.log("sns received:" + JSON.stringify(event, null, 2));
  var slackMessage = null;
  var eventSubscriptionArn = event.Records[0].EventSubscriptionArn;
  var eventSnsSubject = event.Records[0].Sns.Subject || 'no subject';
  var eventSnsMessageRaw = event.Records[0].Sns.Message;
  var eventSnsMessage = null;

  try {
    eventSnsMessage = JSON.parse(eventSnsMessageRaw);
  }
  catch (e) {
  }

  if(eventSubscriptionArn.indexOf(config.services.codepipeline.match_text) > -1 || eventSnsSubject.indexOf(config.services.codepipeline.match_text) > -1 || eventSnsMessageRaw.indexOf(config.services.codepipeline.match_text) > -1){
    console.log("processing codepipeline notification");
    slackMessage = handleCodePipeline(event,context)
  }
  else if(eventSubscriptionArn.indexOf(config.services.elasticbeanstalk.match_text) > -1 || eventSnsSubject.indexOf(config.services.elasticbeanstalk.match_text) > -1 || eventSnsMessageRaw.indexOf(config.services.elasticbeanstalk.match_text) > -1){
    console.log("processing elasticbeanstalk notification");
    slackMessage = handleElasticBeanstalk(event,context)
  }
  else if(eventSnsMessage && 'AlarmName' in eventSnsMessage && 'AlarmDescription' in eventSnsMessage){
    console.log("processing cloudwatch notification");
    slackMessage = await handleCloudWatch(event,context);
  }
  else if(eventSubscriptionArn.indexOf(config.services.codedeploy.match_text) > -1 || eventSnsSubject.indexOf(config.services.codedeploy.match_text) > -1 || eventSnsMessageRaw.indexOf(config.services.codedeploy.match_text) > -1){
    console.log("processing codedeploy notification");
    slackMessage = handleCodeDeploy(event,context);
  }
  else if(eventSubscriptionArn.indexOf(config.services.elasticache.match_text) > -1 || eventSnsSubject.indexOf(config.services.elasticache.match_text) > -1 || eventSnsMessageRaw.indexOf(config.services.elasticache.match_text) > -1){
    console.log("processing elasticache notification");
    slackMessage = handleElasticache(event,context);
  }
  else if(eventSubscriptionArn.indexOf(config.services.autoscaling.match_text) > -1 || eventSnsSubject.indexOf(config.services.autoscaling.match_text) > -1 || eventSnsMessageRaw.indexOf(config.services.autoscaling.match_text) > -1){
    console.log("processing autoscaling notification");
    slackMessage = handleAutoScaling(event, context);
  }
  else{
    slackMessage = handleCatchAll(event, context);
  }

  console.log('SlackMessage', JSON.stringify(slackMessage, true, 2));

  postMessage(slackMessage, function(response) {
    if (response.statusCode < 400) {
      console.info('message posted successfully');
      context.succeed();
    } else if (response.statusCode < 500) {
      console.error("error posting message to slack API: " + response.statusCode + " - " + response.statusMessage);
      // Don't retry because the error is due to a problem with the request
      context.succeed();
    } else {
      // Let Lambda retry
      context.fail("server error when processing message: " + response.statusCode + " - " + response.statusMessage);
    }
  });
};

exports.handler = function(event, context) {
  if (hookUrl) {
    processEvent(event, context);
  } else if (config.unencryptedHookUrl) {
    hookUrl = config.unencryptedHookUrl;
    processEvent(event, context);
  } else if (config.kmsEncryptedHookUrl && config.kmsEncryptedHookUrl !== '<kmsEncryptedHookUrl>') {
    var encryptedBuf = new Buffer(config.kmsEncryptedHookUrl, 'base64');
    var cipherText = { CiphertextBlob: encryptedBuf };
    var kms = new AWS.KMS();

    kms.decrypt(cipherText, function(err, data) {
      if (err) {
        console.log("decrypt error: " + err);
        processEvent(event, context);
      } else {
        hookUrl = "https://" + data.Plaintext.toString('ascii');
        processEvent(event, context);
      }
    });
  } else {
    context.fail('hook url has not been set.');
  }
};
