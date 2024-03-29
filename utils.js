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

const isActionTimeAgain = (lastActionTime, timeList) => {
    const currentTime = Date.now();
    
    // Find the next scheduled action time
    let nextActionTime = null;
    for (const time of timeList) {
        const [hour, minute] = convertLocalTimeToUTC(time, LOCAL_TIME_ZONE).split(':').map(Number);
        const actionDateTime = getTimestampForHourAndMinute(hour, minute);
        
        // If the action time is after the last action time, consider it as the next action time
        if (actionDateTime.getTime() > lastActionTime && currentTime >= actionDateTime.getTime()) {
            nextActionTime = actionDateTime.getTime();
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
    `/addclient phoneNumber - add a new whatsapp web`,
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
    commands: (message, cl) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(commands?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "commands",
            data: {
            },
            respond: (client, message, response) => {
                message.reply(`${FEEDBACK_PREFIX} ${COMMANDS_INFO.join("\n\n")}`);
            }
        }
    },
    groupid: (message, cl) => {
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
                message.reply(`${FEEDBACK_PREFIX} ${waIdToPhone(message.to)}`);
            }
        }
    },
    startpost: (message, cl, posts) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  [interval][interval unit] name
        const regex = /\/(startposts?) ([\d]+)(s|m|h|d|w)/
        const regex2 = /\/(startposts?) ((?:[\d]{1,2}:[\d]{2},? ?)+)/

        const body = message.body
        const matches = body.match(regex)
        const matches2 = body.match(regex2)
        if(!matches && !matches2) return null
        
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
                    interval,
                    intervalUnit,
                    intervalName,
                    intervalMultiplier: intervalMultiplier.amount,
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
            var hoursWithMinutes = parseHoursWithTime(matches2[2])
            var intervalName = hoursWithMinutes.join(",")
            
            result = {
                id: "startpost",
                data: openedGroup? null : {
                    id: generateId(ID_SIZE),
                    from: message.from,
                    groupId,
                    hoursWithMinutes,
                    intervalName,
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
        }

        return result
    },
    endpost: (message, cl, posts) => {
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
                    `${FEEDBACK_PREFIX} Post some contents to add before closing the every ${openedGroup.post.intervalName} post schedule.`
                    :
                    `${FEEDBACK_PREFIX} Every ${openedGroup.post.intervalName} post scheduling complete.`
                );
            }
        }

        return result
    },
    addpost: async (message, cl, posts) => {
        if(!message.from.endsWith("@c.us") || !message.to.endsWith("@g.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        
        var groupId = waIdToPhone(message.to)
        const openedGroup = getGroupLastOpenedPost(groupId, posts)
        if(!openedGroup || openedGroup.post.from != message.from || message.body.startsWith(FEEDBACK_PREFIX)) return null
        
        const result = {
            id: "addpost",
            data: {
                index: openedGroup.index,
                content: {
                    id: generateId(ID_SIZE),
                    text: message.body || "",
                }
            },
            respond: (client, message, response) => {
                message.reply(`${FEEDBACK_PREFIX} Added to every ${openedGroup.post.intervalName} post schedule.`);
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
    lspost: (message, cl) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
        const regex = /\/(lsposts?)/
        const matches = message.body.match(regex)
        if(!matches) return null
        return {
            id: "lspost",
            data: {
            },
            respond: (client, message, response) => {
                client.sendMessage(message.from, `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
            }
        }
    },
    rmpost: (message, cl) => {
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
                message.reply(`${FEEDBACK_PREFIX} ${response || 'Post removed'}`);
            }
        }
    },
    lscontent: (message, cl) => {
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
                client.sendMessage(message.from, `${FEEDBACK_PREFIX} ${response || 'Empty'}`);
            }
        }
    },
    rmcontent: (message, cl) => {
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
                message.reply(`${FEEDBACK_PREFIX} ${response || 'Content removed'}`);
            }
        }
    },
    addclient: (message, cl) => {
        if(!message.from.endsWith("@c.us") || !cl || !["admin", "mod"].includes(cl.rank)) return null
                                //  index
        const regex = /\/(addclient)/
        const matches = message.body.match(regex)
        const quotedMessageSender = message?.quotedMsg?.from
        if(!matches || !quotedMessageSender) return null
        return {
            id: "addclient",
            data: {
                clientId: waIdToPhone(quotedMessageSender),
                rank: cl.rank === "admin"? "mod" : "user"
            },
            respond: (client, message, response) => {
                client.sendMessage(message.from, response || 'Client added');
            }
        }
    },
}
const getRequest = async (message, cl, posts) => {
    if(COMMANDS.commands(message, cl, posts)) {
        return COMMANDS.commands(message, cl, posts)

    } else if(COMMANDS.lspost(message, cl, posts)) {
        return COMMANDS.lspost(message, cl, posts)

    } else if(COMMANDS.rmpost(message, cl, posts)) {
        return COMMANDS.rmpost(message, cl, posts)

    } else if(COMMANDS.lscontent(message, cl, posts)) {
        return COMMANDS.lscontent(message, cl, posts)

    } else if(COMMANDS.rmcontent(message, cl, posts)) {
        return COMMANDS.rmcontent(message, cl, posts)

    } else if(COMMANDS.addclient(message, cl, posts)) {
        return COMMANDS.addclient(message, cl, posts)

    } else if(COMMANDS.groupid(message, cl, posts)) {
        return COMMANDS.groupid(message, cl, posts)
        
    } else if(COMMANDS.startpost(message, cl, posts)) {
        return COMMANDS.startpost(message, cl, posts)
        
    } else if(COMMANDS.endpost(message, cl, posts)) {
        return COMMANDS.endpost(message, cl, posts)
        
    } else if(isCommand(message.body, Object.keys(COMMANDS))) {
        return {
            id: "commanderror",
            data: {},
            respond: (client, message, response) => {
                message.reply(`${FEEDBACK_PREFIX} Command error. use /commands to check how to use each command.`);
            }
        }
    } else {
        const addpost = await COMMANDS.addpost(message, cl, posts)
        if(addpost) {
            return addpost

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