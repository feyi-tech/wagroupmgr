const fs = require("fs")
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const { cwd } = require('process');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const { FEEDBACK_PREFIX, ID_SIZE, LOCAL_TIME_ZONE } = require("./constants");

const getChromePath = () => {
    let chromePath = '';

    //console.log("platform: ", os.platform())
    if (os.platform() === 'win32') {
        try {
            //console.log("Win:")
            chromePath = execSync('where chrome').toString().trim();
        } catch (error) {
            //console.error('Google Chrome not found on Windows.');
            chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        }
    } else if (os.platform() === 'darwin') {
        try {
            chromePath = execSync('mdfind "kMDItemDisplayName == \'Google Chrome\'" | head -n 1').toString().trim();
        } catch (error) {
            console.error('Google Chrome not found on macOS.');
        }
    } else if (os.platform() === 'linux') {
        const chromePaths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/snap/bin/chromium-browser',
            '/usr/lib/chromium-browser/chromium-browser',
            '/usr/bin/chrome',
            '/usr/bin/chromium'
        ];
        for (const path of chromePaths) {
            if (fs.existsSync(path)) {
                chromePath = path;
                break;
            }
        }
        if (!chromePath) {
            console.error('Google Chrome not found on Linux.');
        }
    } else {
        console.error('Unsupported operating system.');
    }

    return chromePath;
}

const waIdToPhone = waId => {
    var id = waId.split("@")[0].replace(/[\+\-\s]+/g, "")
    if(id.startsWith("0")) id = `234${id.substring(1)}`
    return id
}
const phoneToWaId = phone => {
    var id = waIdToPhone(phone)
    return `${id}@c.us`
}
const phoneToGroupId = phone => {
    var id = waIdToPhone(phone)
    return `${id}@g.us`
}
const isCommand = (text, prefixes) => {
    return prefixes.some(prefix => text.startsWith(`/${prefix}`));
}

const orderlySend = (client, message, contents, onContent, onAllSent, index = 0) => {
    if(contents.length == 0) {
        if(onAllSent) onAllSent(client, message)
        return
    }
    const { to, media, text } = onContent(contents[0], index)

    if(media) {
        client.sendMessage(to, media, { caption: text })
        .then(() => {
            contents.shift()
            index++
            orderlySend(client, message, contents, onContent, onAllSent, index)
        })
        .catch(e => {
            contents.shift()
            index++
            orderlySend(client, message, contents, onContent, onAllSent, index)
            console.log("orderlySend:Media Error ", e.message)
        })

    } else {
        client.sendMessage(to, text)
        .then(() => {
            contents.shift()
            index++
            orderlySend(client, message, contents, onContent, onAllSent, index)
        })
        .catch(e => {
            contents.shift()
            index++
            orderlySend(client, message, contents, onContent, onAllSent, index)
            console.log("orderlySend: Error ", e.message)
        })
    }
}

const getObjectIndexById = (id, objectsList) => {
    return objectsList.findIndex(obj => obj.id === id);
}

const generateId = (ID_SIZE) => {
    const characters = 'abcdefghijkmnpqrstuvwxyz23456789'; // Removing confusing characters
    let id = '';
    const charactersLength = characters.length;
    for (let i = 0; i < ID_SIZE; i++) {
        id += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return id;
}

function convertLocalTimeToUTC(localTime, timeDiff) {
    const [hours, minutes] = localTime.split(':').map(Number);
    let utcHours = hours - timeDiff;

    // Handle negative UTC hours
    if (utcHours < 0) {
        utcHours += 24;
    }
    // Handle UTC hours exceeding 24
    else if (utcHours >= 24) {
        utcHours -= 24;
    }

    // Format UTC hours and minutes
    const utcHoursFormatted = utcHours < 10 ? `0${utcHours}` : utcHours;
    const minutesFormatted = minutes < 10 ? `0${minutes}` : minutes;

    return `${utcHoursFormatted}:${minutesFormatted}`;
}

function getTimestampForHourAndMinute(hour, minute, day) {
    const now = new Date();
    if(day) now.setUTCDate(day)
    now.setUTCHours(hour);
    now.setUTCMinutes(minute);
    now.setUTCSeconds(0);
    now.setUTCMilliseconds(0);
    return now.getTime();
}

function orderTimeList(timeList) {
    return timeList.sort((a, b) => {
        const [aHour, aMinute] = a.split(':').map(Number);
        const [bHour, bMinute] = b.split(':').map(Number);
        
        if (aHour !== bHour) {
            return aHour - bHour;
        } else {
            return aMinute - bMinute;
        }
    });
}

const parseHoursWithTime = (timeStringList) => {
    var intervalName = timeStringList.trim().replace(/\s/g, "")
    if(intervalName.endsWith(",")) intervalName = intervalName.substring(0, intervalName.length - 1)

    return orderTimeList(intervalName.split(","))
}

const isActionTimeAgain = (lastActionTime, timeList, timeZone) => {
    const currentTime = Date.now();
    
    // Find the next scheduled action time
    let nextActionTime = null;
    for (const time of timeList) {
        const [hour, minute] = convertLocalTimeToUTC(time, timeZone).split(':').map(Number);
        const actionDateTime = getTimestampForHourAndMinute(hour, minute);
        
        // If the action time is after the last action time, consider it as the next action time
        if (actionDateTime > lastActionTime && currentTime >= actionDateTime) {
            nextActionTime = actionDateTime;
            break;
        }
    }
    
    // If nextActionTime is null, it means all action times have passed for today or the current time has not reached the next action time
    return nextActionTime !== null
}

const COMMANDS_INFO = [
    `/commands - list all commands.`,
    `/groupid - paste in any group to get the group id.`,
    `/startpost interval - schedule all posts sent after the command is sent. \n'interval' can be in seconds(s), minutes(m), hours(h), days(d), or week(w).\n e.g 2h for 2 hours`,
    `/endpost - signify that you're done with the posts being added to a schedule.`,
    `/rmpost index - remove a schedule post. "index" is the post position. Check /lspost`,
    `/lspost - list all schedule post.`,
    `/startclient phoneNumber - add a new whatsapp web`,
    `/rmclient index - remove a client. "index" is the client position. Check /lsclient`,
    `/lsclient - list all client`

]

const intervalUnitToMulitplier = (intervalUnit) => {
    if(intervalUnit === "s") {
        return {amount: 1000, name: 'second', namePlural: 'seconds'}

    } else if(intervalUnit === "m") {
        return {amount: 1000 * 60, name: 'minute', namePlural: 'minutes'}

    } else if(intervalUnit === "h") {
        return {amount: 1000 * 60 * 60, name: 'hour', namePlural: 'hours'}

    } else if(intervalUnit === "d") {
        return {amount: 1000 * 60 * 60 * 24, name: 'day', namePlural: 'days'}

    } else if(intervalUnit === "w") {
        return {amount: 1000 * 60 * 60 * 24 * 7, name: 'week', namePlural: 'weeks'}

    } else {
        return null
    }
}

const getGroupLastOpenedPost = (groupId, posts) => {
    for(var i = posts.length - 1; i >= 0; i--) {
        if(posts[i].groupId == groupId && !posts[i].closed) {
            return {index: i, post: posts[i]}
        }
    }
    return null
}

const COMMANDS = {
    commands: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(commands?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "commands",
            data: {
            },
            respond: (client, message, response) => {
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${COMMANDS_INFO.join("\n\n")}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${COMMANDS_INFO.join("\n\n")}`);
                }
            }
        }
    },
    groupid: (message, cl, posts, group) => {
        //console.log(`to: ${message.to} || ends: ${!message.to.endsWith("@g.us")} || !cl: ${!cl} || permitted: ${!["admin", "mod"].includes(cl.rank)}`)
        if(!message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(groupid)/
        const matches = message.body.match(regex)
        //console.log("groupid: ", matches)
        if(!matches) return null
        return {
            id: "groupid",
            data: {
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${waIdToPhone(message.to)}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${waIdToPhone(message.to)}`);
                }
            }
        }
    },
    startpost: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  [interval][interval unit] name
        const regex = /\/(startposts?) ([\d]+)(s|m|h|d|w)/
        const regex2 = /\/(startposts?) ((?:[\d]{1,2}:[\d]{2},? ?)+)/
        const regex3 = /\/(startposts?) ([a-z0-9]+)/

        const body = message.body
        const matches = body.match(regex)
        const matches2 = body.match(regex2)
        const matches3 = body.match(regex3)
        if(!matches && !matches2 && !matches3) return null
        
        var groupId = waIdToPhone(message.to)
        const openedGroup = getGroupLastOpenedPost(groupId, posts)
        let result
        if(matches) {
            var interval = parseInt(matches[2].trim())
            var intervalUnit = matches[3].trim().toLowerCase()
            var intervalMultiplier = intervalUnitToMulitplier(intervalUnit)
            if(!intervalUnitToMulitplier || interval < 1) return

            var intervalName = interval > 1? `${interval} ${intervalMultiplier.namePlural}` : intervalMultiplier.name
            
            result = {
                id: "startpost",
                data: openedGroup? null : {
                    id: generateId(ID_SIZE),
                    from: message.from,
                    groupId,
                    period: {
                        interval,
                        intervalUnit,
                        intervalName,
                        intervalMultiplier: intervalMultiplier.amount
                    },
                    contents: [],
                    closed: false
                },
                respond: (client, message) => {
                    
                    message.reply(
                        openedGroup?
                        `${FEEDBACK_PREFIX} Please close your currently opened post schedule first.`
                        :
                        `${FEEDBACK_PREFIX} Every ${intervalName} post scheduling opened to receive contents.`
                    );
                }
            }

        } else if(matches2) {
            var hoursWithMinutes = parseHoursWithTime(matches2[2])
            var intervalName = hoursWithMinutes.join(",")
            
            result = {
                id: "startpost",
                data: openedGroup? null : {
                    id: generateId(ID_SIZE),
                    from: message.from,
                    groupId,
                    period: {
                        hoursWithMinutes,
                        intervalName,
                        timezone: LOCAL_TIME_ZONE
                    },
                    contents: [],
                    closed: false
                },
                respond: (client, message) => {
                    
                    message.reply(
                        openedGroup?
                        `${FEEDBACK_PREFIX} Please close your currently opened post schedule first.`
                        :
                        `${FEEDBACK_PREFIX} Every ${intervalName} post scheduling opened to receive contents.`
                    );
                }
            }
            
        } else {
            
            result = {
                id: "startpost",
                data: openedGroup? null : {
                    id: matches3[2].trim(),
                    isPostContentsEdit: true
                },
                respond: (client, message, response) => {
                    
                    message.reply(
                        openedGroup?
                        `${FEEDBACK_PREFIX} Please close your currently opened post schedule first.`
                        :
                        `${FEEDBACK_PREFIX} ${response || `The post scheduling has been reopened to receive contents.`}`
                    );
                }
            }
        }

        return result
    },
    endpost: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  [interval][interval unit] name
        const regex = /\/(endposts?)/
        const body = message.body
        const matches = body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)
        const openedGroup = getGroupLastOpenedPost(groupId, posts)
        
        const result = {
            id: "endpost",
            data: !openedGroup || openedGroup.post.contents.length == 0? null : {
                index: openedGroup.index
            },
            respond: (client, message) => {
                
                message.reply(
                    !openedGroup?
                    `${FEEDBACK_PREFIX} No opened post schedule to close.`
                    :
                    openedGroup.post.contents.length == 0?
                    `${FEEDBACK_PREFIX} Post some contents to add before closing the every ${openedGroup.post.period.intervalName} post schedule.`
                    :
                    `${FEEDBACK_PREFIX} Every ${openedGroup.post.period.intervalName} post scheduling complete.`
                );
            }
        }

        return result
    },
    editperiod: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        
        const regex = /\/(editperiod?) ([a-z0-9]+) ([\d]+)(s|m|h|d|w)/
        const regex2 = /\/(editperiod?) ([a-z0-9]+) ((?:[\d]{1,2}:[\d]{2},? ?)+)/

        const matches = message.body.match(regex)
        const matches2 = message.body.match(regex2)
        if(!matches && !matches2) return null

        let data
        if(matches) {
            var interval = parseInt(matches[3].trim())
            var intervalUnit = matches[4].trim().toLowerCase()
            var intervalMultiplier = intervalUnitToMulitplier(intervalUnit)
            if(!intervalUnitToMulitplier || interval < 1) return

            var intervalName = interval > 1? `${interval} ${intervalMultiplier.namePlural}` : intervalMultiplier.name

            data = {
                id: matches[2].trim(),
                period: {
                    interval,
                    intervalUnit,
                    intervalName,
                    intervalMultiplier: intervalMultiplier.amount
                }
            }

        } else {
            var hoursWithMinutes = parseHoursWithTime(matches2[3])
            var intervalName = hoursWithMinutes.join(",")

            data = {
                id: matches2[2].trim(),
                period: {
                    hoursWithMinutes,
                    intervalName,
                    timezone: LOCAL_TIME_ZONE
                }
            }
        }
        return {
            id: "editperiod",
            data,
            respond: (client, message, response) => {
                
                message.reply(`${FEEDBACK_PREFIX} ${response || 'Post schedule period changed.'}`);
            }
        }
    },
    addcontent: async (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        
        var groupId = waIdToPhone(message.to)
        const openedGroup = getGroupLastOpenedPost(groupId, posts)
        if(!openedGroup || openedGroup.post.from != message.from || message.body.startsWith(FEEDBACK_PREFIX)) return null
        
        const result = {
            id: "addcontent",
            data: {
                index: openedGroup.index,
                content: {
                    id: generateId(ID_SIZE),
                    text: message.body || "",
                }
            },
            respond: (client, message, response) => {
                
                message.reply(`${FEEDBACK_PREFIX} Added to every ${openedGroup.post.period.intervalName} post schedule.`);
            }
        }

        let filepath
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            // do something with the media data here
            const ext = media.mimetype.split('/')[1].split(";", 2)[0]
            filepath = path.join(cwd(), `./files/${message.id.id}.${ext}`)
            fs.writeFileSync(filepath, Buffer.from(media.data, 'base64').toString('binary'), 'binary');
            result.data.content.filepath = filepath
            result.data.content.mimetype = media.mimetype
            result.data.content.extension = ext
        }

        return result
    },
    lspost: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(lsposts?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "lspost",
            data: {
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
                } else {
                    client.sendMessage(message.from, `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
                }
            }
        }
    },
    rmpost: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(rmpost?) ([a-z0-9]+)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "rmpost",
            data: {
                id: matches[2].trim()
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Post removed'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Post removed'}`);
                }
            }
        }
    },
    lscontent: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(lscontents?) ([a-z0-9]+)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "lscontent",
            data: {
                id: matches[2].trim()
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
                } else {
                    client.sendMessage(message.from, `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
                }
            }
        }
    },
    rmcontent: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(rmcontent?) ([a-z0-9]+)_([a-z0-9]+)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "rmcontent",
            data: {
                postId: matches[2].trim(),
                contentId: matches[3].trim()
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Content removed'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Content removed'}`);
                }
            }
        }
    },
    startclient: (message, cl, posts, group) => {
        if((
            !message?.quotedMsg?.from && !message?.quotedParticipant && !message?._data?.quotedMsg?.from && !message?._data?.quotedParticipant
        ) || !message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(startclient?)/
        const matches = message.body.match(regex)
        const quotedMessageSender = message?.quotedMsg?.from || message?.quotedParticipant || message?._data?.quotedMsg?.from || message?._data?.quotedParticipant
        if(!matches || !quotedMessageSender) return null
        return {
            id: "startclient",
            data: {
                clientId: waIdToPhone(quotedMessageSender),
                rank: cl.rank === "admin"? "mod" : "user"
            },
            respond: (client, response, msg) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Client added'}`);
                } else {
                    if(msg) {
                        msg.reply(`${FEEDBACK_PREFIX} ${response || 'Client added'}`);
    
                    } else {
                        client.sendMessage(message.from, `${FEEDBACK_PREFIX} ${response || 'Client added'}`);
                    }
                }
            }
        }
    },
    rmclient: (message, cl, posts, group) => {
        return null
        if(!message?.quotedMsg?.from && !message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(rmclient?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "rmclient",
            data: {
                clientId: waIdToPhone(quotedMessageSender)
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Client removed'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Client removed'}`);
                }
            }
        }
    },
    uploadcontacts: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(uploadcontacts?|ulcontacts?)\s+(.*)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "uploadcontacts",
            data: {
                regex: matches[2]
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Contacts shared'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Contacts shared'}`);
                }
            }
        }
    },
    downloadcontacts: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(downloadcontacts?|dlcontacts?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "downloadcontacts",
            data: {},
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Contacts shared'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Contacts downloaded'}`);
                }
            }
        }
    },
    addmembers: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || (!message.to.endsWith("@g.us") && !message?._data?.quotedMsg?.body) || !cl || !["admin"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(addmembers?)\s+(\d*)\s+(.*)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = message.to? waIdToPhone(message.to) : message?._data?.quotedMsg.body
        var maxAdded = parseInt(matches[2].trim())
        var contactRegex = matches[3]

        return {
            id: "addmembers",
            data: {
                groupId, maxAdded, contactRegex
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
    setgroup: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(setgroup)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)

        return {
            id: "setgroup",
            data: {
                groupId
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
    unsetgroup: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(unsetgroup)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)

        return {
            id: "unsetgroup",
            data: {},
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
    welcome: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !message?._data?.quotedMsg?.body || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(welcome)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)

        return {
            id: "welcome",
            data: {
                groupId,
                welcomeMessage: message?._data?.quotedMsg?.body
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
    clocksize: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(clocksize) ([\d]+)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)

        return {
            id: "clocksize",
            data: {
                clocksize: parseInt(matches[2].trim()) * 1000
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
    //Use to copy the members already added to source group to destination group mebers added log so that only members not added
    // in the source group will be added in the destination group during adding.
    linkgroup: (message, cl, posts, group) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(linkgroup) ([\d]+)/
        const matches = message.body.match(regex)
        if(!matches) return null

        var groupId = waIdToPhone(message.to)

        return {
            id: "linkgroup",
            data: {
                sourceGroup: matches[2].trim(),
                destinationGroup: groupId
            },
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} ${response || 'Ok.'}`);
                }
            }
        }
    },
}
const getRequest = async (message, cl, posts, group) => {
    if(COMMANDS.commands(message, cl, posts, group)) {
        return COMMANDS.commands(message, cl, posts, group)

    } else if(COMMANDS.lspost(message, cl, posts, group)) {
        return COMMANDS.lspost(message, cl, posts, group)

    } else if(COMMANDS.rmpost(message, cl, posts, group)) {
        return COMMANDS.rmpost(message, cl, posts, group)

    } else if(COMMANDS.lscontent(message, cl, posts, group)) {
        return COMMANDS.lscontent(message, cl, posts, group)

    } else if(COMMANDS.rmcontent(message, cl, posts, group)) {
        return COMMANDS.rmcontent(message, cl, posts, group)

    } else if(COMMANDS.startclient(message, cl, posts, group)) {
        return COMMANDS.startclient(message, cl, posts, group)

    } else if(COMMANDS.rmclient(message, cl, posts, group)) {
        return COMMANDS.rmclient(message, cl, posts, group)

    } else if(COMMANDS.groupid(message, cl, posts, group)) {
        return COMMANDS.groupid(message, cl, posts, group)
        
    } else if(COMMANDS.startpost(message, cl, posts, group)) {
        return COMMANDS.startpost(message, cl, posts, group)
        
    } else if(COMMANDS.endpost(message, cl, posts, group)) {
        return COMMANDS.endpost(message, cl, posts, group)
        
    } else if(COMMANDS.editperiod(message, cl, posts, group)) {
        return COMMANDS.editperiod(message, cl, posts, group)
        
    } else if(COMMANDS.uploadcontacts(message, cl, posts, group)) {
        return COMMANDS.uploadcontacts(message, cl, posts, group)
        
    } else if(COMMANDS.downloadcontacts(message, cl, posts, group)) {
        return COMMANDS.downloadcontacts(message, cl, posts, group)
        
    } else if(COMMANDS.addmembers(message, cl, posts, group)) {
        return COMMANDS.addmembers(message, cl, posts, group)
        
    } else if(COMMANDS.setgroup(message, cl, posts, group)) {
        return COMMANDS.setgroup(message, cl, posts, group)
        
    } else if(COMMANDS.unsetgroup(message, cl, posts, group)) {
        return COMMANDS.unsetgroup(message, cl, posts, group)
        
    } else if(COMMANDS.welcome(message, cl, posts, group)) {
        return COMMANDS.welcome(message, cl, posts, group)
        
    } else if(COMMANDS.clocksize(message, cl, posts, group)) {
        return COMMANDS.clocksize(message, cl, posts, group)
        
    } else if(COMMANDS.linkgroup(message, cl, posts, group)) {
        return COMMANDS.linkgroup(message, cl, posts, group)
        
    } else if(isCommand(message.body, Object.keys(COMMANDS))) {
        return {
            id: "commanderror",
            data: {},
            respond: (client, message, response) => {
                
                if(group) {
                    client.sendMessage(phoneToGroupId(group), `${FEEDBACK_PREFIX} Command error. use /commands to check how to use each command.`);
                } else {
                    message.reply(`${FEEDBACK_PREFIX} Command error. use /commands to check how to use each command.`);
                }
            }
        }
    } else {
        const addcontent = await COMMANDS.addcontent(message, cl, posts, group)
        if(addcontent) {
            return addcontent

        }
    }
    return null
}

module.exports = {
    getChromePath,
    waIdToPhone, phoneToWaId, phoneToGroupId,
    getRequest, orderlySend, getObjectIndexById,
    convertLocalTimeToUTC, getTimestampForHourAndMinute, isActionTimeAgain
}