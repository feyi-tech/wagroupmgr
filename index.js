const fs = require("fs")
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const { getChromePath, getRequest, waIdToPhone, testPath, phoneToGroupId, phoneToWaId, orderlySend, getObjectIndexById, getTimestampForHourAndMinute } = require('./utils')
const { ADMIN, FEEDBACK_PREFIX } = require("./constants")

var clientsWa = {}
var clients = {}
var posts = []

const config = JSON.parse(fs.readFileSync("config.json"))
console.log("Admin: ", config.admin)

/// Initialize WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade
const server = http.createServer();

server.on('upgrade', function upgrade(request, socket, head) {
  const pathname = request.url;
  const clientId = pathname.substr(1); // Extract client ID from URL (removing the leading '/')
  if (!clientsWa[clientId]) {
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
    if (!clientsWa[clientId]) {
      res.render('onboard', { mod: config.mod });
      return;
    }
  
    res.render('index', { clientId: clientId });
});

app.get('/:clientId', (req, res) => {
  const clientId = req.params.clientId;
  if (!clientsWa[clientId]) {
    res.render('onboard', { mod: config.mod });
    return;
  }

  res.render('index', { clientId: clientId, port: SOCK_PORT, qr: clientsWa[clientId].qr });
});

// Start Express server
const PORT = process.env.WEB_PORT || config.web_port;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const updateQRCode = (clientId, qr) => {
    if (clientsWa[clientId]) {
        clientsWa[clientId].qr = qr;
        // Notify all connected clients about the updated QR code
        wss.clients.forEach(function each(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ clientId: clientId, qr: qr }));
            }
        });
    }
};

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

const getPosts = () => {
    if(posts.length > 0) return posts
    try {
        var info = fs.readFileSync("./data/posts.json")
        posts = JSON.parse(info)
        
        return posts
    } catch(e) {
        return []
    }
}

const startPost = (data) => {
    if(!data) return
    const all = getPosts()
    all.push(data)
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
}
const endPost = (data) => {
    if(!data) return
    const all = getPosts()
    all[data.index].closed = true
    all[data.index].last_sent_at = Date.now()
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
}
const addPost = (data) => {
    if(!data) return
    const all = getPosts()
    all[data.index].contents.push(data.content)
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
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
        
        const text = `ID: ${post.id}\nInterval: ${post.intervalName}\nGroupId: ${post.groupId}\nLastPostedOn: ${date? date.toISOString() : "Still scheduling."}`
        
        client.sendMessage(message.from, text);
        message.reply(`${FEEDBACK_PREFIX} List of posts has been sent to your DM.`)
    }
}

const rmPost = (client, message, data) => {
    const all = getPosts()
    const postIndex = getObjectIndexById(data.id, all)
    if(postIndex == -1) {
        return message.reply(`${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" does not exist.`)
    }
    all.splice(postIndex, 1);
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
    message.reply(`${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" has been removed.`)
}

const lsContent = (client, message, data) => {
    const all = getPosts()
    const dataIndex = getObjectIndexById(data.id, all)

    if(dataIndex == -1) {
        message.reply(`${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" does not exist.`)
        return;
    }
    const parent = all[dataIndex]

    const contents = parent.contents
    if(contents.length == 0) {
        message.reply(`${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.id}" has no content yet.`)
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
        message.reply(`${FEEDBACK_PREFIX} List of contents has been sent to your DM.`)
    })
}

const rmContent = (client, message, data) => {
    const all = getPosts()
    const postIndex = getObjectIndexById(data.postId, all)
    if(postIndex == -1) {
        return message.reply(`${FEEDBACK_PREFIX} The scheduled post(s) with ID, "${data.postId}" does not exist.`)
    }
    const contents = all[postIndex].contents
    const contentIndex = getObjectIndexById(data.contentId, contents)
    if(contentIndex == -1) {
        return message.reply(`${FEEDBACK_PREFIX} The content with ID, "${data.contentId}" of the scheduled post(s) with ID, "${data.postId}" does not exist.`)
    }
    contents.splice(contentIndex, 1);
    all.contents = contents
    posts = all
    fs.writeFileSync("./data/posts.json", JSON.stringify(all, null, '\t'))
    message.reply(`${FEEDBACK_PREFIX} The content with ID, "${data.contentId}" of the scheduled post(s) with ID, "${data.postId}" has been removed.`)
}

const addClient = (clientId, rank) => {
    if(!clientsWa[clientId]) {
        const all = getAllClients()
        all[clientId] = { id: clientId, rank }
        clients = all
        fs.writeFileSync("./data/clients.json", JSON.stringify(all, null, '\t'))
        startClients()
    }
}

const removeClient = (clientId) => {
    if(clientsWa[clientId]) {
        clientsWa[clientId].destroy()
        const all = getAllClients()
        delete all[clientId]
        clients = all
        fs.writeFileSync("./data/clients.json", JSON.stringify(all, null, '\t'))
    }
}

const getClient = (clientId) => {
    if(clientsWa[clientId]) {
        const all = getAllClients()
        return all[clientId]
    }
}

const getClientStatus = (clientId) => {
    if(!clientsWa[clientId]) {
        const all = getAllClients()
        all[clientId] = { id: clientId }
        fs.writeFileSync("./data/clients.json", JSON.stringify(all, null, '\t'))
    }
}

const getGroup = async(client) => {
    //client.sendMessage("120363049643907139@g.us", `Guerra solicitada?`);
    /*
	const chats = await client.getChats();
    for(const chat of chats) {
        if (chat.isGroup) {
            if(chat?.name === "MyRecordings") {
                console.log(`Group[${JSON.stringify(chat?.id || {})}]: `, chat)
                try {
                    client.sendMessage(chat?.id, `Guerra solicitada?`);
                    console.log("Sucess: ", JSON.stringify(chat?.id || {}))

                } catch(e) {}
            }
        }
    }*/
}

const startClients = () => {
    try {
        var clients = getAllClients()

        for(const [key, value] of Object.entries(clients)) {
            if(!clientsWa[key]) {
                const client = new Client({
                    authStrategy: new LocalAuth({
                        clientId: key
                    }),
                    puppeteer: {
                        executablePath: getChromePath(),
                    }
                });
                
                client.on('ready', () => {
                    console.log('Client is ready!');
                    updateQRCode(key, "ready");
                    clientsWa[key].ready = true
                    getGroup(client)
                });
                
                client.on('qr', qr => {
                    qrcode.generate(qr, {small: true});
                    updateQRCode(key, qr);
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
                    
                    getRequest(message, cl, posts)
                    .then(req => {
                        console.log("Req: ", req)
                        if(req?.id === "commands") {
                            req.respond(client, message)
                    
                        } else if(req?.id === "commanderror") {
                            req.respond(client, message)
                    
                        } else if(req?.id === "addclient") {
                            addClient(req.data.clientId, req.data.rank);
                            req.respond(client, message)
                    
                        } else if(req?.id === "removeClient") {
                            removeClient(req.data);
                            req.respond(client, message)
                    
                        } else if(req?.id === "getClientStatus") {
                            getClientStatus(req.data);
                            req.respond(client, message)

                        } else if(req?.id === "startpost") {
                            startPost(req.data);
                            req.respond(client, message)

                        } else if(req?.id === "endpost") {
                            endPost(req.data);
                            req.respond(client, message)

                        } else if(req?.id === "addpost") {
                            addPost(req.data);
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
                            req.respond(client, message)

                        } else if(req?.id === "startGroupAdding") {
                            //startGroupAdding(req.data);
                            //req.respond(client, message)

                        } else if(req?.id === "stopGroupAdding") {
                            //startGroupAdding(req.data);
                            //req.respond(client, message);
                            
                        } else if(req?.id === "stopGroupAdding") {
                            //startGroupAdding(req.data);
                            //req.respond(client, message)
                            
                        } else {
                            client.sendMessage(message.from, "No action request.");
                        }
                    })
                });
                
                
                client.initialize();

                clientsWa[key] = { client, ready: false }
            }
        }
    } catch(e) {
        console.log("startClients:error ", e.message)
    }
}


const sendPosts = () => {
    const now = Date.now()
    const client = clientsWa[config.mod]?.client
    //console.log("Ready: ", clientsWa[config.mod]?.ready)
    if(!client || !clientsWa[config.mod]?.ready) return
    const all = getPosts()
    //console.log("Ready:posts ", all)
    var sent = false
    for(var i = 0; i < all.length; i++) {
        const post = all[i]
        const postId = post.id
        //console.log("Ready:post ", phoneToGroupId(post.groupId), post.filepath)
        let isPostingTime
        const lastSentAt = post.last_sent_at || 0
        if(post.hoursWithMinutes) {
            const lastPostDate = new Date()
            lastPostDate.setTime(lastSentAt)
            nextPostTime = now >= getTimestampForHourAndMinute(post.hour, post.minute)

        } else {
            isPostingTime = now >= lastSentAt + (post.interval * post.intervalMultiplier)
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
    }
}

const addMembers = () => {

}

const loop = (interval) => {
    setTimeout(() => {
        sendPosts()
        addMembers()
        loop()
    }, interval);
}

addClient(config.admin, ADMIN)
loop(config.loop_interval_milli)
//testPath("x.png")