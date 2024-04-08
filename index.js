const fs = require("fs")
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const { getChromePath, getRequest, waIdToPhone, testPath, phoneToGroupId, phoneToWaId, orderlySend, getObjectIndexById, getTimestampForHourAndMinute, isActionTimeAgain } = require('./utils')
const { ADMIN, FEEDBACK_PREFIX } = require("./constants")

var contacts = {}
var contactsAddedToGroups = {}
var groupLinks = {}
var clients = {}
var posts = []
var currentWa = null

console.log = () => {}

const config = JSON.parse(fs.readFileSync("config.json"))
console.log("Admin: ", config.admin)

/// Initialize WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade
const server = http.createServer();

server.on('upgrade', function upgrade(request, socket, head) {
  const pathname = request.url;
  const clientId = pathname.substr(1); // Extract client ID from URL (removing the leading '/')
  if (currentWa?.id != clientId) {
    // If client ID doesn't exist, close the connection
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, function done(ws) {
    wss.emit('connection', ws, request);
  });
});

// Websocket Express server
const SOCK_PORT = process.env.SOCK_PORT || config.sock_port;
server.listen(SOCK_PORT, () => {
  console.log(`WebSocket server is listening on port ${SOCK_PORT}`);
});

// Express setup
const app = express();
app.set('view engine', 'ejs'); // Using EJS template engine
app.use(express.static('public')); // Serve static files (like CSS or images) from the 'public' directory

// Route to serve HTML page connecting to WebSocket
app.get('/', (req, res) => {
    const clientId = req.params.clientId;
    if (currentWa?.id != clientId) {
      res.render('onboard', { mod: config.mod });
      return;
    }
  
    res.render('index', { clientId: clientId });
});

app.get('/:clientId', (req, res) => {
  const clientId = req.params.clientId;
  if (currentWa?.id != clientId) {
    res.render('onboard', { mod: config.mod });
    return;
  }

  res.render('index', { clientId: clientId, socketUrl: config.webSocketUrl, qr: currentWa.qr });
});

// Start Express server
const PORT = process.env.WEB_PORT || config.web_port;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const sendMessage = (client, message, body) => {
    if(!config.feedbackGroup) {
        message.reply(`${FEEDBACK_PREFIX} ${body}`)

    } else {
        client.sendMessage(phoneToGroupId(config.feedbackGroup), `${body}`)
    }
}

const getAllClients = () => {
    if(Object.keys(clients).length > 0) return clients
    try {
        var clientsInfo = fs.readFileSync("./data/clients.json")
        clients = JSON.parse(clientsInfo)
        
        return clients
    } catch(e) {
        return {}
    }
}

const getSavedContacts = () => {
    if(Object.keys(contacts).length > 0) return contacts
    try {
        var info = fs.readFileSync("./data/contacts.json")
        contacts = JSON.parse(info)
        
        return contacts
    } catch(e) {
        return {}
    }
}

const saveContacts = (contactsToSave) => {
    contacts = contactsToSave
    fs.writeFileSync("./data/contacts.json", JSON.stringify(contactsToSave, null, '\t'))
}

const getGroupLinks = () => {
    if(Object.keys(groupLinks).length > 0) return groupLinks
    try {
        var info = fs.readFileSync("./data/group-links.json")
        groupLinks = JSON.parse(info)
        
        return groupLinks
    } catch(e) {
        return {}
    }
}

const saveGroupLinks = (links) => {
    groupLinks = links
    fs.writeFileSync("./data/group-links.json", JSON.stringify(groupLinks, null, '\t'))
}

const getContactsAddedToGroups = () => {
    if(Object.keys(contactsAddedToGroups).length > 0) return contactsAddedToGroups
    try {
        var info = fs.readFileSync("./data/contacts-added-to-groups.json")
        contactsAddedToGroups = JSON.parse(info)
        
        return contactsAddedToGroups
    } catch(e) {
        return {}
    }
}

const saveContactsAddedToGroups = (contactsToSave) => {
    contactsAddedToGroups = contactsToSave
    fs.writeFileSync("./data/contacts-added-to-groups.json", JSON.stringify(contactsToSave, null, '\t'))
}

const sendLink = clientId => {
    if(Date.now() < (currentWa?.lastLinkSentTime || 0) + config.sendLinkIntervalMilli) return
    const clients = getAllClients()
    for(const [key, value] of Object.entries(clients)) {
        if(key != clientId && currentWa?.client && currentWa?.ready) {
            const client = currentWa?.client
            client.sendMessage(phoneToWaId(clientId), `Please click the link below to login to the portal:\n\n${config.serverBaseUrl}${clientId}`)
            break;
        }

    }
}

const updateQRCode = (clientId, qr) => {
    if (currentWa) {
        currentWa.qr = qr;
        // Notify all connected clients about the updated QR code
        wss.clients.forEach(function each(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ clientId: clientId, qr: qr }));
            }
        });
        sendLink(clientId)
    }
};

const getPosts = () => {
    if(posts.length > 0) return posts
    try {
        var info = fs.readFileSync("./data/posts.json")
        posts = JSON.parse(info)
        //In case some posts were being made before the server shutdown, flag them back to not posting so they can be retried.
        posts.forEach(post => post.posting = false);
        
        return posts
    } catch(e) {
        return []
    }
}

const startPost = (data) => {
    if(!data) return
    const all = getPosts()
    if(data.isPostContentsEdit) {
        const index = getObjectIndexById(data.id, all)
        if(index == -1) {
            return `The scheduled post(s) with ID, "${data.id}" does not exist.`

        }
        all[index].closed = false
        posts = all
        fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
        return `The ${all[index].period.intervalName} scheduled post(s) with ID, "${data.id}" has been reopened to receive contents.`

    } else {
        all.push(data)
        posts = all
        fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
        return null
    }
}
const endPost = (data) => {
    if(!data) return
    const all = getPosts()
    all[data.index].closed = true
    all[data.index].last_sent_at = Date.now()
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
}
const addContent = (data) => {
    if(!data) return
    const all = getPosts()
    all[data.index].contents.push(data.content)
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
}
const editPeriod = (data) => {
    if(!data) return
    const all = getPosts()
    const dataIndex = getObjectIndexById(data.id, all)
    
    if(dataIndex == -1) {
        return `The scheduled post(s) with ID, "${data.id}" does not exist.`
    }

    const initialIntervalName = all[dataIndex].period.intervalName
    all[dataIndex].period = data.period
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))

    return `The post interval of the scheduled post(s) with ID, "${data.id}" has been changed from ${initialIntervalName} to ${data.period.intervalName}.`
}

const lsPost = (client, message) => {
    const all = getPosts()
    if(all.length == 0) {
        message.reply(`${FEEDBACK_PREFIX} No scheduled post yet.`)
        return;
    }
    for (let index = 0; index < all.length; index++) {
        const post = all[index]
        var date = new Date()
        if(post.last_sent_at) {
            date.setTime(post.last_sent_at)

        } else {
            date = null
        }
        
        const text = `ID: ${post.id}\nInterval: ${post.period.intervalName}\nGroupId: ${post.groupId}\nLastPostedOn: ${date? date.toISOString() : "Still scheduling."}`
        
        client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, text);
    }
}

const rmPost = (client, message, data) => {
    const all = getPosts()
    const postIndex = getObjectIndexById(data.id, all)
    if(postIndex == -1) {
        return client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" does not exist.`)
    }
    all.splice(postIndex, 1);
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
    client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" has been removed.`)
}

const lsContent = (client, message, data) => {
    const all = getPosts()
    const dataIndex = getObjectIndexById(data.id, all)

    if(dataIndex == -1) {
        client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" does not exist.`)
        return;
    }
    const parent = all[dataIndex]

    const contents = parent.contents
    if(contents.length == 0) {
        client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" has no content yet.`)
        return;
    }
    orderlySend(client, message, JSON.parse(JSON.stringify(contents)), (post, index) => {
        const text = `\nID: ${data.id}_${post.id}\n\n${post.text}`
        
        let media;
        if(post.filepath) {
            try {
                media = MessageMedia.fromFilePath(post.filepath);

            } catch(e) {}
        }
        return { to: message.from, media, text }
    }, (client, message) => {
        client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} List of contents has been sent to your DM.`)
    })
}

const rmContent = (client, message, data) => {
    const all = getPosts()
    const postIndex = getObjectIndexById(data.postId, all)
    if(postIndex == -1) {
        return client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.postId}" does not exist.`)
    }
    const contents = all[postIndex].contents
    const contentIndex = getObjectIndexById(data.contentId, contents)
    if(contentIndex == -1) {
        return client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The content with ID, "${data.contentId}" of the scheduled post(s) with ID, "${data.postId}" does not exist.`)
    }
    contents.splice(contentIndex, 1);
    all.contents = contents
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
    client.sendMessage(config.feedbackGroup? phoneToGroupId(config.feedbackGroup) : message.from, `${FEEDBACK_PREFIX} The content with ID, "${data.contentId}" of the scheduled post(s) with ID, "${data.postId}" has been removed.`)
}

const setGroup = (client, message, data) => {
    config.feedbackGroup = data.groupId
    fs.writeFileSync("./config.json", JSON.stringify(config, null, '\t'))
}
const unsetGroup = (client, message, data) => {
    delete config.feedbackGroup
    fs.writeFileSync("./config.json", JSON.stringify(config, null, '\t'))
}

const startClient = (clientId, rank) => {
    if(currentWa?.id != clientId) {
        const all = getAllClients()
        if(!all[clientId]) {
            all[clientId] = { id: clientId, rank: rank }
            clients = all
            fs.writeFileSync("./data/clients.json", JSON.stringify(all, null, '\t'))
        }
        
        runClient(clientId)

    } else {
        runClient(clientId)
    }
}

const removeClient = (client, message, data) => {
    if(currentWa) {
        currentWa.client.destroy()
        const all = getAllClients()
        delete all[data.clientId]
        delete currentWa
        clients = all
        fs.writeFileSync("./data/clients.json", JSON.stringify(all, null, '\t'))
        message.reply("Client removed.")

    } else {
        message.reply("Client already does not exist.")
    }
}

const getClient = (clientId) => {
    const all = getAllClients()
    return all[clientId]
}

const getContacts = ( client, filter, exclude = [], numbersOnly = false ) => {
    return new Promise((resolve, reject) => {
        var filterRegex = filter? new RegExp(filter, "i") : /^.*$/
        //console.log("filterRegex: ", filterRegex)
        client.getContacts()
        .then(contacts => {
            const validUsers = contacts.filter(
                user => 
                !user.isMe && user.isUser && user.isWAContact && user.isMyContact && 
                !user.isBlocked && user?.id?.server === "c.us" && 
                (user.name || "").match(filterRegex) &&
                !exclude.includes(user.number)
            );
            if(numbersOnly) {
                resolve(validUsers.map(user => user.number))

            } else {
                resolve(validUsers)
            }
        })
        .catch(reject)
    })
}

const sendContacts = (client, clientId, contacts) => {
    return new Promise((resolve, reject) => {
        getContacts(client, null, [], true)
        .then(phoneNumbers => {
            const contactCards = []
            for(const contact of contacts) {
                if(!phoneNumbers.includes(contact.number)) {
                    contactCards.push(`BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL:${contact.number}\nEND:VCARD`)
                }
            }
            if(contactCards.length > 0) {
                try {
                    const vCardText = contactCards.join('\n\n');
                    const vCardBuffer = Buffer.from(vCardText);
                    // Convert Buffer to Base64
                    const vCardBase64 = vCardBuffer.toString('base64');
                    // Create MessageMedia with Base64 encoded data
                    const media = new MessageMedia('text/vcard', vCardBase64, `contacts-${contactCards.length}-${(new Date()).toISOString()}.vcf`);
                    client.sendMessage(phoneToWaId(clientId), media, { caption: `${FEEDBACK_PREFIX} This file contains ${contactCards.length} contacts.\n\nClick the file to save the contacts all at once.` });
                    resolve(contactCards.length)

                } catch(e) {
                    reject(e)
                }

            } else {
                resolve(0)
            }
        })
        .catch(reject)
    })
}

const uploadContacts = (client, message, data) => {
    const contactSource = currentWa?.client
    if(!contactSource) {
        return message.reply(`${FEEDBACK_PREFIX} Client info not found. Contact the dev.`)
    }
    if(!currentWa.ready) {
        return message.reply(`${FEEDBACK_PREFIX} Client Not ready.`)
    }

    getContacts(client, data.regex, [], false)
    .then(contacts => {
        if(contacts.length == 0) {
            if(!config.feedbackGroup) {
                return message.reply(`${FEEDBACK_PREFIX} No contacts found to upload.`)
    
            } else {
                return client.sendMessage(phoneToGroupId(config.feedbackGroup), `No contacts found to upload.`)
            }
        }

        const savedContacts = getSavedContacts()
        const savedContactsNumbers = Object.keys(savedContacts)
        var totalShared = 0
        for(const contact of contacts) {
            if(!savedContactsNumbers.includes(contact.number)) {
                savedContacts[contact.number] = {
                    name: contact.name,
                    number: contact.number
                }
                totalShared++
            }
        }
        saveContacts(savedContacts)
        if(!config.feedbackGroup) {
            message.reply(`${FEEDBACK_PREFIX} A total of ${totalShared} contacts was uploaded for clients to download for saving.`)

        } else {
            client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} A total of ${totalShared} contacts was uploaded for clients to download for saving.`)
        }

    })
    .catch(e => {
        console.log("Contacts:error ", e.message)
       
        if(!config.feedbackGroup) {
            message.reply(`${FEEDBACK_PREFIX} Total error: ${e.message}.`)

        } else {
            client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} Total error: ${e.message}.`)
        }
    })
}

const downloadContacts = (client, message, data) => {
    const contactSource = currentWa?.client
    if(!contactSource) {
        if(!config.feedbackGroup) {
            return message.reply(`${FEEDBACK_PREFIX} Client info not found. Contact the dev.`)

        } else {
            return client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} Client info not found. Contact the dev.`)
        }
    }
    if(!currentWa.ready) {
        if(!config.feedbackGroup) {
            return message.reply(`${FEEDBACK_PREFIX} Client Not ready.`)

        } else {
            return client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} Client Not ready.`)
        }
    }

    sendContacts(client, currentWa.id, Object.values(getSavedContacts()))
    .then(totalSent => {
        if(config.feedbackGroup && totalSent > 0) {
            client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} ${`A total of ${totalSent} contacts has been sent to ${currentWa.id}. Please click to save.`}`)

        } else {
            sendMessage(client, message, `${FEEDBACK_PREFIX} No contacts to download.`)
        }

    })
    .catch(e => {
        console.log("Contacts:error ", e.message)
        sendMessage(client, message, `${FEEDBACK_PREFIX} Total error: ${e.message}.`)
    })
}

const addMembers = (client, message, data) => {
    const { groupId, maxAdded, contactRegex } = data
    
    const allContactsAddedToGroups = getContactsAddedToGroups()
    const linkId = getGroupLinks()[groupId] || groupId
    
    const contactsAddedToGroup = allContactsAddedToGroups[linkId] || []
    getContacts(client, contactRegex, contactsAddedToGroup, false)
    .then(contacts => {
        console.log("addMembers:- ", contacts)
        if(contacts.length == 0) {
            if(!config.feedbackGroup) {
                return message.reply(`${FEEDBACK_PREFIX} No contacts found to add.`)
    
            } else {
                return client.sendMessage(phoneToGroupId(config.feedbackGroup), `No contacts found to add.`)
            }
        }
        
        var totalAdded = 0
        const contactsToAdd = []
        const contactsToAddSerialized = []
        for(const contact of contacts) {
            if(totalAdded == maxAdded) break;
            contactsToAdd.push(contact.number)
            contactsToAddSerialized.push(phoneToWaId(contact.number))
            totalAdded++
        }

        client.getChatById(phoneToGroupId(groupId))
        .then(group => {
            group.addParticipants(contactsToAddSerialized)
            .then(() => {
                allContactsAddedToGroups[linkId] = contactsAddedToGroup.concat(contactsToAdd)
                saveContactsAddedToGroups(allContactsAddedToGroups)
                sendMessage(client, message, `A total of ${totalAdded} contacts was successfully added to the group.`)

            })
            .catch(e => {
                sendMessage(client, message, "Failed to send message.")
            })
        })
        .catch(e => {
            console.log("addMembers::error ", e.message)
        })

    })
    .catch(e => {
        console.log("Contacts:error ", e.message)
       
        if(!config.feedbackGroup) {
            message.reply(`${FEEDBACK_PREFIX} Total error: ${e.message}.`)

        } else {
            client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} Total error: ${e.message}.`)
        }
    })
}

const runClient = (clientId) => {
    if(currentWa?.client) {
        currentWa.client.destroy()
        currentWa = null
    }
    try {
        const client = new Client({
            restartOnAuthFail: true,
            authStrategy: new LocalAuth({
                clientId: clientId
            }),
            puppeteer: {
                executablePath: getChromePath(),
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
            },
            webVersionCache: {
                type: 'remote',
                remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${config.wwebVersion}.html`,
            },
        });
        
        client.on('ready', () => {
            console.log('Client is ready!');
            updateQRCode(clientId, "ready");
            client.sendMessage(phoneToWaId(clientId), `${FEEDBACK_PREFIX} You've successfully logged in!.`)
            if(config.feedbackGroup) {
                client.sendMessage(phoneToGroupId(config.feedbackGroup), `${FEEDBACK_PREFIX} Client with ID. ${clientId} successfully logged in!.`)
            }
            currentWa.ready = true
        });
        
        client.on('qr', qr => {
            currentWa.ready = false
            qrcode.generate(qr, {small: true});
            updateQRCode(clientId, qr);
        });
        
        
        // Listening to all incoming messages
        client.on('message_create', (message) => {
            if(!message.ack) return
            //Only process direct chats and group chats
            if(!message.from.endsWith("@c.us") && !message.from.endsWith("@g.us")) return
            console.log("Message: ", message)
            const cl = getClient(waIdToPhone(message.from))
            console.log("cl: ", cl, ` | phone: ${waIdToPhone(message.from)} | from: ${message.from} | to: ${message.to}`)
            if(!cl || !Object.keys(getAllClients()).includes(cl?.id || "-")) return
            
            getRequest(message, cl, posts, config.feedbackGroup)
            .then(req => {
                console.log("Req: ", req)
                if(req?.id === "commands") {
                    req.respond(client, message)
            
                } else if(req?.id === "commanderror") {
                    req.respond(client, message)
            
                } else if(req?.id === "startpost") {
                    const response = startPost(req.data);
                    req.respond(client, message, response)

                } else if(req?.id === "endpost") {
                    endPost(req.data);
                    req.respond(client, message)

                } else if(req?.id === "editperiod") {
                    const response = editPeriod(req.data);
                    req.respond(client, message, response)

                } else if(req?.id === "addcontent") {
                    addContent(req.data);
                    req.respond(client, message)

                } else if(req?.id === "rmpost") {
                    rmPost(client, message, req.data)

                } else if(req?.id === "rmcontent") {
                    rmContent(client, message, req.data)

                } else if(req?.id === "lspost") {
                    lsPost(client, message);

                } else if(req?.id === "lscontent") {
                    lsContent(client, message, req.data)

                } else if(req?.id === "groupid") {
                    req.respond(client, message, "None")

                } else if(req?.id === "startclient") {
                    startClient(req.data.clientId, req.data.rank)
            
                } else if(req?.id === "rmclient") {
                    removeClient(client, message, req.data);
            
                } else if(req?.id === "uploadcontacts") {
                    uploadContacts(client, message, req.data);
            
                } else if(req?.id === "downloadcontacts") {
                    downloadContacts(client, message, req.data);
            
                } else if(req?.id === "addmembers") {
                    addMembers(client, message, req.data);
                    req.respond(client, message, message)
            
                } else if(req?.id === "setgroup") {
                    setGroup(client, message, req.data);
                    req.respond(client, message, `Group ${req.data.groupId} set as the feedback group`)
            
                } else if(req?.id === "unsetgroup") {
                    unsetGroup(client, message, req.data);
                    req.respond(client, message, "Feedback group removed")
            
                } else if(req?.id === "welcome") {
                    config.welcomeMessage = req.data.welcomeMessage
                    config.welcomeMessageGroup = req.data.groupId
                    fs.writeFileSync("./config.json", JSON.stringify(config, null, '\t'))
                    req.respond(client, message, "Welcome message updated.")
            
                } else if(req?.id === "clocksize") {
                    config.loop_interval_milli = req.data.clocksize
                    fs.writeFileSync("./config.json", JSON.stringify(config, null, '\t'))
                    req.respond(client, message, "Clock size updated.")
            
                } else if(req?.id === "linkgroup") {
                    const links = getGroupLinks()
                    links[req.data.destinationGroup] = req.data.sourceGroup
                    saveGroupLinks(links)
                    req.respond(client, message, `Group ${req.data.destinationGroup} has been linked to group ${req.data.sourceGroup}`)
            
                } else {
                    //client.sendMessage(message.from, "No action request.");
                }
            })
        });
        
        
        client.initialize();

        currentWa = { id: clientId, client, ready: false }
    } catch(e) {
        console.log("startClient:error ", e.message)
    }
}

const welcomeNewUsers = () => {/*
    if(
        config.welcomeMessage && config.welcomeMessageGroup && 
        currentWa?.client && currentWa?.ready && !["admin", "mod"].includes(allClients[currentWa?.id || ""]?.rank)
    ) {
        currentWa.client.getChatById(phoneToGroupId(config.welcomeMessageGroup))
        .then(group => {
            if((group.participants || []).length > lastParticipantsCounts[config.welcomeMessageGroup] || 0 ) {
                lastParticipantsCounts[config.welcomeMessageGroup] = group.participants.length
                currentWa.client.sendMessage(phoneToGroupId(config.welcomeMessageGroup), config.welcomeMessage)
            }
        })
        .catch(e => {
            console.log("addMembers::error ", e.message)
        })
    }*/
}

const sendPosts = () => {
    const now = Date.now()
    const client = currentWa?.client
    //console.log("Ready: ", currentWa?.ready)
    const allClients = getAllClients()
    if(!client || !currentWa?.ready || !["admin", "mod"].includes(allClients[currentWa?.id || ""]?.rank)) return
    const all = getPosts()
    //console.log("Ready:posts ", all)
    var sent = false
    for(var i = 0; i < all.length; i++) {
        const post = all[i]
        const postId = post.id
        //console.log("Ready:post ", phoneToGroupId(post.groupId), post.filepath)
        let isPostingTime
        const lastSentAt = post.last_sent_at || 0
        if(post.period.hoursWithMinutes) {
            isPostingTime = isActionTimeAgain(lastSentAt, post.period.hoursWithMinutes, post.period.timezone)

        } else {
            isPostingTime = now >= lastSentAt + (post.period.interval * post.period.intervalMultiplier)
        }
        if(post.closed && !post.posting && post.last_sent_at && post.contents.length > 0 && isPostingTime) {
            all[i].posting = true
            sent = true

            orderlySend(client, null, JSON.parse(JSON.stringify(post.contents)), (content) => {
                let media;
                if(content.filepath) {
                    try {
                        media = MessageMedia.fromFilePath(content.filepath);

                    } catch(e) {}
                }
                return { to: phoneToGroupId(post.groupId), text: content.text, media }
            }, () => {
                const all = getPosts()
                const index = getObjectIndexById(postId, all)//The posts size(so index) might have changed before this callback is called
                if(index > -1) {
                    all[index].posting = false
                    all[index].last_sent_at = Date.now()
                    posts = all
                    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
                }
            })
        }
    }
    if(sent) {
        posts = all
        fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))

    } else {
        welcomeNewUsers()
    }
}

const loop = (interval) => {
    setTimeout(() => {
        sendPosts()
        loop(config.loop_interval_milli)
    }, interval);
}

startClient(config.admin, ADMIN)
loop(config.loop_interval_milli)
//testPath("x.png")