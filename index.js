const Discord = require('discord.js');
const async = require('async');
const uuid = require('uuid/v5');

let client = new Discord.Client();

const yes_emoji='627636749685751809';
const no_emoji='627636769365557249';
const maybe_emoji='🥔';
const vote_emoji='616849561951928320';
function is_emoji(thing, name){
    return thing.name == name || thing.id == name;
}

const bot_color = 0x102080;

function pack_guid_data(a,b){
    const buf = Buffer.alloc(16);

    buf.writeBigUInt64LE(a,
        buf.writeBigUInt64LE(b,0)
    );
    
    const hex_base = buf.toString('hex',0,32);
    const hex = ((hex_base.length == 32) && hex_base) || ('0'.repeat(32-hex_base.length) + hex_base);
    const o = [hex.substr(26, 6),hex.substr(22,4),hex.substr(18,4),hex.substr(14,4),hex.substr(0,14)].join('-');
    
    return o;
}

function get_channel_key(channel){
    const channel_id = channel.id;
    const base_id = (channel.type == 'dm') ? channel.recipient.id : channel.guild.id;

    return pack_guid_data(BigInt(base_id), BigInt(channel_id));
}



function extract_guid_data(dat){

    const buf = Buffer.alloc(
        16,
        dat.substr(dat.length - 14, 14) +
        dat.substr(dat.length - ((14+1) + 4),4) +
        dat.substr(dat.length - ((14+1+4+1) + 4),4) +
        dat.substr(dat.length - ((14+1+4+1+4+1) + 4),4) +
        dat.substr(dat.length - ((14+1+4+1+4+1+4+1) + 6),6),
        'hex');

    return [
        buf.readBigUInt64LE(8),
        buf.readBigUInt64LE(0)
    ];
}

{
    const test_ints=[BigInt('230423088234'),BigInt('123401283413')];
    const packed_guid = pack_guid_data(test_ints[0], test_ints[1]);
    const unpacked_ints = extract_guid_data(packed_guid);
    if(test_ints[0]!=unpacked_ints[0] || test_ints[1]!=unpacked_ints[1]){
        console.log('missmatch',[test_ints,unpacked_ints]);
    }
}

function make_kind(type_proto){
    let queued_count=0;

    function dec_queue_count(entity, err){
        
        if (err){
            console.log('on entity',entity,'has error',err);
        }

        queued_count = queued_count - 1;

        if(0 == queued_count){
            type_proto.finished_queue();
        }
    }

    return {
        map:{},
        _type_proto:type_proto,
        _increment_queue:()=>{
            queued_count = 1 + queued_count;
            
        }
    }
}
function resend(self, message, users){
    
    const dat = message.embeds[0];
    const vote_id = dat.footer.text;
                
    sending = new Discord.RichEmbed(
        dat
    );

    sending.setFooter(
        self.key+':'+vote_id,
        message.guild.iconURL);

    users.forEach(
        member=>{
            if(member.user && !member.user.bot){
                member.user.send(
                    sending
                ).then(
                    sent=>{

                        sent.react(yes_emoji).then(()=>{
                            sent.react(no_emoji).then(()=>{
                                sent.react(maybe_emoji);
                            })
                        });
                    }
                ).catch(e=>console.log(e));
            }
        }
    );
}

const kinds = {
    vote : make_kind(
    {
        filter_options:{
            limit:100
        },
        filter:(message)=>(
            message.author.id == client.user.id &&
             message.content == '' &&
              1 == message.embeds.length &&
              message.embeds[0].color == bot_color),
        handle:(message)=>{},
        get_key:(item)=>get_channel_key(item),
        item_type: Discord.TextChannel,
        make:(entity)=>{
            entity.votes={};
            return entity;
        },
        finished_queue:()=>{
            console.log('finished parsing messages in all text channels.');

            // run through dm channels..
            client
                .channels
                .filter(channel=>channel.type == 'dm')
                .forEach(channel=>push_queue(kinds.ballot,channel));
        },
        on_message:(self,message,is_recall)=>{
            const dat = message.embeds[0];
            const vote_id = dat.footer.text;
            self.votes[vote_id]={
                key:vote_id,
                dat:dat,
                message:message,
                voters:{}
            };

            if(!is_recall){
                resend(self, message, message.channel.members);
            }
        }
    }),
    ballot : make_kind({
        filter_options:{
            limit:100
        },
        filter:(message)=>(
            message.author.id == client.user.id &&
             message.content == '' &&
              1 == message.embeds.length &&
              message.embeds[0].color == bot_color),
        handle:(message)=>{},
        get_key:(item)=>get_channel_key(item),
        item_type: Discord.DMChannel,
        make:(entity)=>{
            entity.votes={};
            return entity;
        },
        finished_queue:()=>{
            console.log('finished parsing messages in all ballot dms.');
            empty_late();
        },
        on_message:(self,message,is_recall)=>{
        }
    })
};


function scan_channel_messages(options, callbacks){
    console.log('scanning:',callbacks);
    return callbacks.self.item.fetchMessages(options)
        .then(
            (messages)=>{
                try{
                    messages = messages.filter(
                        callbacks.self._kind._type_proto.filter,
                        callbacks.self
                    );
                }catch(e){
                    if(callbacks.error){
                        return callbacks.error(e);
                    }
                    messages={size:0};
                }

                console.log('found ' +messages.size+' messages:',callbacks.self);

                messages.forEach(message=>{
                    try{
                        callbacks.self._kind._type_proto.on_message(
                            callbacks.self,
                            message,
                            true);
                    }catch(e){
                        console.log(e);
                    }
                });

                if(callbacks.done){
                    callbacks.done();
                }
            }
        )
        .catch(err=>{console.log('while scanning:',err); if(callbacks.error){callbacks.error(err);}});
}


let scan_queue = async.queue(
    (task,callback)=>{
        if (task === task._kind.map[task.key]){

            scan_channel_messages(
                task._kind._type_proto.filter_options,
            {
                self: task,
                done:()=>callback(task),
                error:(err)=>callback(task,err),
                handle:task._kind._type_proto.handle,
                filter:task._kind._type_proto.filter,
                empty:()=>callback(task)
            });
        }else{
            callback();// move on with life.
        }
    }
);
    
function review_messages(kind, item){
    const entity_init = {
        _kind:kind,
        key:kind._type_proto.get_key(item),
        item:item,
    };
    const entity = kind._type_proto.make(entity_init) || entity_init;
    kind.map[entity.key] = entity;

    console.log('bound for messaging:',entity);
 
    return entity;
}

function push_queue(kind, item){
    return scan_queue.push(
        review_messages(kind,item),
        kind._increment_queue());
}

client.on('ready', ()=>{
    
    scan_queue.pause();

    client.guilds.forEach((guild)=>{
        guild.channels.forEach((channel)=>{
            push_queue(kinds.vote, channel);
        });
    });

    scan_queue.resume();
});

late_messages=[];

function get_kind(message){
    return (message.channel.type == 'dm') ? kinds.ballot : kinds.vote;
}

function get_rel(message,kind_implant){

    const kind = kind_implant || get_kind(message);

    return kind.map[kind._type_proto.get_key(message.channel)] || 
        review_messages(kind,message.channel);
}

function emit_notice(message){
    const kind = get_kind(message);
    const entity = get_rel(message,kind);
    
    if(entity && kind._type_proto.filter.call(entity, message)){

        kind._type_proto.on_message(
            entity,
            message,
            false);

    }
}

function empty_late(){
    const copy = late_messages.slice(0);
    late_messages = [];

    copy.forEach(message=>{
        try{
            emit_notice(message);
        } catch (e){
            console.log(e);
        }
    });
}

client.on('message', message=>{
    if(message.author.id == client.user.id){
        if( (!scan_queue.idle()) || scan_queue.paused){
            late_messages.push(message);
        }else{
            empty_late();
            emit_notice(message);
        }
    }else if(!message.author.bot) {
        if(message.channel.type == 'dm'){

        }else if(message.channel.type == 'text'){
            const content = message.content;
            if(message.content.startsWith('!nominate ')){
                let str = content.substr('!nominate '.length).trim();
                let desc = '';
                const first_lineret = str.search('\n');

                if(first_lineret != -1 && str.length != (first_lineret+1)){
                    desc = str.substr(first_lineret+1);
                    str = str.substr(0,first_lineret).trim();
                }

                if(str.startsWith('\\')){
                    str = str.substr(1);
                }

                if(str.startsWith('<@!') && str.endsWith('>')){
                    str = str.substr(3,str.length-4).trim();
                }
                let promise = null;
                let fields=[];
                try{
                    const desc_lines = desc.split('\n');
                    desc = '';

                    desc_lines.forEach(line=>{
                        const text = line.trim();
                        const colon = 
                            ((text.search(':')+1) ||
                            (text.search(';')+1))-1;

                        if (colon != -1){
                            fields.push({
                                name: colon == 0 ? '\u200b' : text.substr(0,colon).trim(),
                                value: (text.length == (colon+1)) ? "\u200b" : text.substr(colon+1).trim(),
                                inline: text[colon] == ';'
                            });
                        }else{
                            desc = desc + '\n'+ text;
                        }
                    });

                    promise = client
                        .fetchUser(str,false);
                }catch(e){
                    console.log(e);
                    return;
                }
                promise.then(
                    found_user=>{
                        const vote_channel = get_rel(message);
                        if(vote_channel){
                            const vote_id = pack_guid_data(
                                BigInt(found_user.id),
                                BigInt(message.author.id)
                            );


                            const embed = new Discord.RichEmbed(
                                {
                                    color:bot_color,
                                    title:found_user.username,
                                    author:{
                                        text:message.member.displayName,
                                        icon_url:(message.author.displayAvatarURL||message.author.defaultAvatarURL),
                                        url:'https://google.com/search?q='+message.author.id
                                    },
                                    image:{
                                        url:(found_user.displayAvatarURL||found_user.defaultAvatarURL)
                                    },
                                    timestamp:message.createdTimestamp,
                                    description:''+found_user+'('+found_user.tag+') was nominated by '+message.author+'\n'+desc,
                                    footer:{
                                        text:vote_id
                                    },
                                    fields:fields
                                }
                            );

                            message.channel.send(
                                embed
                            ).then(sent=>{
                                sent.react(vote_emoji);
                                message.author.send(embed.footer.text).catch(e=>console.log(e));
                            });
                        }
                    }
                );
            }else if(content.startsWith('!status ')){
                const uuid=content.substr('!status '.length).trim();
                try{
                    const vote_ints = extract_guid_data(uuid);
                    const vote_id = pack_guid_data(vote_ints[0],vote_ints[1]);
                    const self= get_rel(message);

                    if(self){
                        const vote = self.votes[vote_id];

                        if(!vote){
                            message.channel.send('no such vote id '+message.author);
                        }else{
                            let vote_results = {
                                yes:0,
                                no:0,
                                maybe:0,
                                none:0,
                                invalid:0,
                                shipped:0,
                                error:0
                            };

                            async.each(
                                message.channel.members,
                                (item_arr, cb)=>{
                                    const item = item_arr[1];
                                    if( item.user && !(item.user.bot) ){
                                        let dm_channel = [item.user.dmChannel];

                                        if(!dm_channel[0]){
                                            client.channels.forEach(chn=>{
                                                if(chn.type == 'dm' && chn.recipient.id == item.user.id){
                                                    dm_channel[0]=chn;
                                                }
                                            });
                                        }
                                        function find_in_messages(messages){
                                            const filtered = messages.filter(kinds.ballot._type_proto.filter).array();
                                            let index = filtered.length - 1;
                                            while(index >= 0){
                                                const at_index = filtered[index];
                                                const str = at_index.embeds[0].footer.text;

                                                if(vote_id == str.substr(str.search(':')+1).trim()){
                                                    
                                                    const reactions = at_index.reactions.filter(
                                                        reaction=>{
                                                            return (
                                                        (
                                                            is_emoji(reaction.emoji,maybe_emoji)||
                                                            is_emoji(reaction.emoji,yes_emoji)||
                                                            is_emoji(reaction.emoji,no_emoji)
                                                        ) && (2 == reaction.count)
                                                    );}).array();

                                                    let ballot={
                                                        yes:0,
                                                        no:0,
                                                        maybe:0
                                                    };

                                                    reactions.forEach(reaction=>{
                                                        if(is_emoji(reaction.emoji,maybe_emoji)){
                                                            ballot.maybe = ballot.maybe + 1;
                                                        }else if(is_emoji(reaction.emoji,no_emoji)){
                                                            ballot.no = ballot.no + 1;
                                                        }else if(is_emoji(reaction.emoji,yes_emoji)){
                                                            ballot.yes = ballot.yes + 1;
                                                        }
                                                    });

                                                    ballot.sum = ballot.yes + ballot.no + ballot.maybe;

                                                    if(ballot.sum == 1){
                                                        vote_results.yes = vote_results.yes + ballot.yes;
                                                        vote_results.no = vote_results.no + ballot.no;
                                                        vote_results.maybe = vote_results.maybe + ballot.maybe;
                                                        
                                                        return cb();
                                                    }
                                                    else
                                                    {
                                                        function i_cant_send_you_it(e){

                                                        }
                                                        try{
                                                            if(ballot.sum == 0){
                                                                vote_results.none = vote_results.none + 1;

                                                                cb();
                                                                item.user
                                                                    .send('Please make a selection:' + at_index.url)
                                                                    .catch(i_cant_send_you_it);
                                                            }else{
                                                                vote_results.invalid = vote_results.invalid + 1;
                                                                cb();

                                                                item.user
                                                                    .send('You have too many selections:' + at_index.url)
                                                                    .catch(i_cant_send_you_it);
                                                            }
                                                        }catch(e){
                                                            console.log(e);
                                                        }
                                                        return;
                                                    }
                                                }
                                                index = index - 1;
                                            }

                                            vote_results.shipped = vote_results.shipped + 1;

                                            try{resend(self, vote.message, [item]);}catch(e){
                                                console.log(e);
                                            }

                                            cb();
                                        }

                                        function fire_dm(){
                                            return dm_channel[0].fetchMessages(
                                                kinds.ballot._type_proto.filter_options
                                                ).then(find_in_messages)
                                                .catch(e=>cb(e));
                                        }

                                        if(dm_channel[0]){
                                            fire_dm();
                                        }else{
                                            return item.user.createDM().then(channel=>{
                                                dm_channel[0]=channel;
                                                fire_dm();
                                            }).catch(e=>{
                                                message.channel.send('could not open dm for ' + item.user);
                                                vote_results.error = vote_results.error + 1;
                                                cb();
                                            });
                                        }
                                    }else{
                                        cb();
                                    }
                                },
                                (err)=>{
                                    message.channel.send(
                                        'Results as requested by ' + message.author +'\n```json\n'+
                                        JSON.stringify(vote_results,null,2) +'```'+err);
                                }
                            );
                        }
                    }
                }catch(e){
                    console.log(e);
                }
            }
        }
    }
});

client.on('messageReactionAdd', (messageReaction,user)=>{
    if(user != client.user){
        if( messageReaction.message.channel.type == 'text' &&
            messageReaction.message.author == client.user ){
            if(kinds.vote._type_proto.filter(messageReaction.message)){
                const self = get_rel(messageReaction.message);
                if(self){
                    let members_to_resend=[];

                    messageReaction.message.channel.members.forEach(member=>{
                        if(member.user.id == user.id){
                            members_to_resend.push(member);
                        }
                    });

                    resend(self, messageReaction.message, members_to_resend);
                }
            }
        }
    }
});


client.login(
    require('./ballotbotconfig.js').secret
);
