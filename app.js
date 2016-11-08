#!/usr/bin/env node

'use strict';


const Fs = require('fs');
const _ = require('lodash');
const Cheerio = require('cheerio');
const MD5 = require('blueimp-md5');
const Async = require('async');
const SuperAgent = require('superagent');
const Charset = require('superagent-charset');
const Retry = require('superagent-retry');
const Moment = require('moment');
const Inquirer = require('inquirer');
const Chalk = require('chalk');


let gHeaders = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, sdch',
    'Accept-Language': 'zh-CN,zh;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Host': 'wos.chijidun.com',
    'Pragma': 'no-cache',
    'Referer': 'http://wos.chijidun.com/order.html',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.75 Safari/537.36 QQBrowser/4.1.4132.400',
    'X-Requested-With': 'XMLHttpRequest'
};

let gCookie = [];

let gInfo = {
    'cid': '',
    'time': '00:00:00',
    'members': {}, // 餐厅列表
    'address': {}, // 收获地址
    'order': false, // 订单 id
};

main();

function init() {
    Charset(SuperAgent);
    Retry(SuperAgent);
}

function main() {
    init();

    console.log(Chalk.yellow('欢迎使用 吃几顿(命令行版)~'));

    return procMain();
}

function procMain() {
    return Async.waterfall([
        function(done) {
            return getLogin(function(res) {
                return updateCookieByHeader(res.header) && done(null, res);
            });
        },
        function(data, done) {
            return menuLogin(function(aws) {
                return done(null, aws);
            });
        },
        function(data, done) {
            return postLogin(data.phone, data.password, function(res) {
                if (res.statusCode !== 302) {
                    return done('登录失败!!!');
                } else {
                    return updateCookieByHeader(res.header) && done(null, res);
                }
            });
        },
        function(data, done) {
            return getOrder(function(res) {
                return !(gInfo.cid = getCid(res.text)) ? done('获取 cid 失败!!!') : done(null, res);
            });
        },
        function(data, done) {
            return getMembersAndOrder(gInfo.cid, function(res) {
                let jsonMembersAndOrder = JSON.parse(res.text);
                gInfo.order = jsonMembersAndOrder.data.order;

                let $members = Cheerio.load(jsonMembersAndOrder.data.members);
                $members('.nav.nav-list > li').each(function(i, elem) {
                    gInfo.members[$members(elem).data('id')] = {
                        'name': $members(elem).text(),
                        'menus': {}
                    };
                });

                let $address = Cheerio.load(jsonMembersAndOrder.data.address);
                $address('li').each(function(i, elem) {
                    gInfo.address[$address(elem).data('id')] = $address(elem).find('.name').text();
                });

                return done(null, res);
            });
        },
        function(data, done) {
            let arrMid = _.keys(gInfo.members);
            return Async.map(arrMid, function(mid, cb) {
                return getMenu(mid, function(res) {
                    let jsonMenu = JSON.parse(res.text);
                    let $menus = Cheerio.load(jsonMenu.data);
                    $menus('li').each(function(i, elem) {
                        let strMark = $menus(elem).find('.color-mark').text();
                        strMark = strMark ? ('(' + strMark + ')') : '';
                        gInfo.members[mid].menus[$menus(elem).data('id')] = $menus(elem).find('.title').text() + strMark;
                    });
                    return cb(null, jsonMenu);
                });
            }, function(err, res) {
                return err ? done(err) : done(null, res);
            });
        }
    ], function (err, res) {
        return err ? console.log(Chalk.red(err)) : showOrderInfo();
    });
}

function menuLogin(done) {
    let questions = [{
        'type': 'input',
        'name': 'phone',
        'message': '手机:',
        'validate': function(input) {
            let pass = input.match(/^1[3|4|5|7|8][0-9]\d{8}$/i);
            if (!input || !pass) {
                return '请输入已验证的手机号码';
            }
            return true;
        }
    }, {
        'type': 'password',
        'name': 'password',
        'message': '密码:',
        'validate': function(input) {
            if (!input) {
                return '请输入密码';
            }
            return true;
        }
    }];

    return Inquirer.prompt(questions).then(function(aws) {
        done && done(aws);
    });
}

function menuAddress(mid, done) {
    let questions = [{
        type: 'list',
        name: 'address',
        message: '请选择收获地址:',
        choices: [],
    }];

    _.forEach(gInfo.address, function(address, id) {
        questions[0].choices.push({
            'name': address,
            'value': id,
        });
    });

    questions[0].choices.push(new Inquirer.Separator());
    questions[0].choices.push({'name': '返回', 'value': 'back'});

    return Inquirer.prompt(questions).then(function(aws) {
        done && done(mid, aws);
    });
}

function menuOrder(done) {
    let questions = [{
        type: 'list',
        name: 'mid',
        message: '您想要点什么呢?',
        choices: [],
    }];

    _.forEach(gInfo.members, function(member, id) {
        questions[0].choices.push(new Inquirer.Separator());
        questions[0].choices.push({
            'name': member.name,
            'disabled': '-。-',
        });
        _.forEach(member.menus, function(menu, id) {
            questions[0].choices.push({
                'name': menu,
                'value': id,
            });
        });
    });

    questions[0].choices.push(new Inquirer.Separator());
    questions[0].choices.push({'name': '返回', 'value': 'back'});

    return Inquirer.prompt(questions).then(function(aws) {
        done && done(aws);
    });
}

function menuSaveOrder(done) {
    let questions = [{
        type: 'list',
        name: 'step',
        message: '您想要做什么?',
        choices: [
            {'name': '点餐', 'value': 'save'},
            {'name': '刷新', 'value': 'refresh'},
            new Inquirer.Separator(),
            {'name': '退出', 'value': 'exit'},
        ],
    }];

    if ((new Date().getTime()) >= getEndTime()) {
        questions[0].choices.shift();
    }

    return Inquirer.prompt(questions).then(function(aws) {
        done && done(aws);
    });
}

function menuDeleteOrder(done) {
    let questions = [{
        type: 'list',
        name: 'step',
        message: '您想要做什么?',
        choices: [
            {'name': '退餐', 'value': 'delete'},
            {'name': '刷新', 'value': 'refresh'},
            new Inquirer.Separator(),
            {'name': '退出', 'value': 'exit'},
        ],
    }];

    if ((new Date().getTime()) >= getEndTime()) {
        questions[0].choices.shift();
    }

    return Inquirer.prompt(questions).then(function(aws) {
        done && done(aws);
    });
}

function getEndTime() {
    let arrTime = gInfo.time.split(':');
    return (new Date().setHours(arrTime[0], arrTime[1], arrTime[2], 0));
}

function showHtmlInfo(strHtml) {
    let $order = Cheerio.load(strHtml);
    gInfo.time = $order('span[name=time]').eq(0).text() + ':00';
    console.log(Chalk.green(`欢迎 ${$order('.company-name').text()}(${$order('.company-desc').text()}) 的用户~`));
    console.log(Chalk.white(`订餐截止时间 `, Chalk.underline.bgRed(gInfo.time)));
}

function showOrderInfo() {
    if (gInfo.order === false) {
        console.log(Chalk.inverse(`您今天还未点餐哦!`));
        return menuSaveOrder(procOrderInfo);
    } else {
        let $lis = Cheerio.load(gInfo.order.lis);
        console.log(Chalk.magenta(`您今天的点餐订单信息:`));
        console.log(Chalk.white(`单号: ${gInfo.order.id}`));
        console.log(Chalk.white(`餐厅: ${$lis('span').text().split('|')[0]}`));
        console.log(Chalk.white(`套餐: ${gInfo.order.menus}`));
        console.log(Chalk.white(`地址: ${gInfo.order.address}`));
        return menuDeleteOrder(procOrderInfo);
    }
}

function updateOrderInfo(done) {
    return getMembersAndOrder(gInfo.cid, function(res) {
        let jsonMembersAndOrder = JSON.parse(res.text);
        if (!jsonMembersAndOrder.data) {
            console.log(Chalk.white(`Cookie 失效, 需要`, Chalk.underline.bgRed(`重新登录`)));
            return procMain();
        }
        gInfo.order = jsonMembersAndOrder.data.order;
        return done && done(res);
    });
}

function procAddress(mid, aws) {
    if (aws.address === 'back') {
        return menuOrder(procOrder);
    } else {
        return saveOrder(mid, aws.address, function(res) {
            return updateOrderInfo(function(res) {
                return showOrderInfo();
            });
        });
    }
}

function procOrder(aws) {
    if (aws.mid === 'back') {
        return showOrderInfo();
    } else {
        return menuAddress(aws.mid, procAddress);
    }
}

function procOrderInfo(aws) {
    switch(aws.step) {
        case 'save':
            return menuOrder(procOrder);
        case 'delete':
            return deleteOrder(gInfo.order.id, function(res) {
                return updateOrderInfo(function(res) {
                    return showOrderInfo();
                });
            });
        case 'refresh':
            return updateOrderInfo(function(res) {
                return showOrderInfo();
            });
        case 'exit':
            return getLogOut(function(res) {
                process.exit(0);
            });
    }
}

function getCid(strHtml) {
    let regexCid = /cid\s=\s'(\d+?)';/i;
    let arrCid = strHtml.match(regexCid);
    return ((arrCid.length !== 2) ? null : arrCid[1]);
}

function findCookieByKey(key) {
    for (let i = 0, len = gCookie.length; i < len; i++) {
        if (gCookie[i].indexOf(key) > -1) {
            return i;
        }
    }
    return -1;
}

function getCookieByStrSetCookie(strSetCookie) {
    return strSetCookie.split(';')[0];
}

function getCookie() {
    return gCookie.join('; ');
}

function setCookie(strCookie) {
    let strKey = strCookie.split('=')[0];
    let index = findCookieByKey(strKey);
    if (index === -1) {
        gCookie.push(strCookie);
    } else {
        gCookie[index] = strCookie;
    }
    return index;
}

function updateCookieByHeader(header) {
    let arrSetCookie = header['set-cookie'] || [];
    return _.forEach(arrSetCookie, function(strSetCookie) {
        setCookie(getCookieByStrSetCookie(strSetCookie));
    });
}

function getLogin(done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': 1
    });
    delete headers['X-Requested-With'];

    return SuperAgent
        .get('http://wos.chijidun.com/login.html')
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function postLogin(username, password, done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookie(),
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/login.html',
        'Upgrade-Insecure-Requests': 1
    });
    delete headers['X-Requested-With'];

    return SuperAgent
        .post('http://wos.chijidun.com/login.html')
        .redirects(0)
        .type('form')
        .withCredentials()
        .set(headers)
        .send(encodeURI(`LoginForm[username]=${username}`))
        .send(encodeURI(`LoginForm[password]=${MD5(password)}`))
        .send(encodeURI(`LoginForm[autoLogin]=1`))
        .send(encodeURI(`yt0=登录`))
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            done && done(res);
        });
}

function getLogOut(done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cookie': getCookie(),
        'Referer': 'http://wos.chijidun.com/order.html',
        'Upgrade-Insecure-Requests': 1
    });
    delete headers['X-Requested-With'];

    return SuperAgent
        .get('http://wos.chijidun.com/logout.html')
        .redirects(0)
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            done && done(res);
        });
}

function getOrder(done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cookie': getCookie(),
        'Referer': 'http://wos.chijidun.com/login.html',
        'Upgrade-Insecure-Requests': 1
    });
    delete headers['X-Requested-With'];

    return SuperAgent
        .get('http://wos.chijidun.com/order.html')
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function getMembersAndOrder(cid, done) {
    let headers = _.assign({}, gHeaders, {
        'Cookie': getCookie(),
    });

    let data = {
        'cid': cid,
        'date': Moment().format('YYYY-MM-DD'),
        'mealType': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return SuperAgent
        .get('http://wos.chijidun.com/order/getMembersAndOrder.html')
        .query(data)
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function getMenu(mid, done) {
    let headers = _.assign({}, gHeaders, {
        'Cookie': getCookie(),
    });

    let data = {
        'mid': mid,
        'date': Moment().format('YYYY-MM-DD'),
        'type': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return SuperAgent
        .get('http://wos.chijidun.com/order/getMenu.html')
        .query(data)
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function saveOrder(menuId, addrId, done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': getCookie(),
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/order.html'
    });

    return SuperAgent
        .post('http://wos.chijidun.com/order/saveOrder.html')
        .redirects(0)
        .type('form')
        .withCredentials()
        .set(headers)
        .send(`items=${menuId}:1;&addrId=${addrId}&mealType=3&date=${Moment().format('YYYY-MM-DD')}`)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function deleteOrder(orderId, done) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': getCookie(),
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/order.html'
    });

    return SuperAgent
        .post('http://wos.chijidun.com/order/deleteOrder.html')
        .redirects(0)
        .type('form')
        .withCredentials()
        .set(headers)
        .send(`orderId=${orderId}`)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function memberFull(mid, done) {
    let headers = _.assign({}, gHeaders, {
        'Cookie': getCookie(),
    });

    let data = {
        'mid': mid,
        'date': Moment().format('YYYY-MM-DD'),
        'type': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return SuperAgent
        .get('http://wos.chijidun.com/order/memberFull.html')
        .query(data)
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}

function getMember(mid, done) {
    let headers = _.assign({}, gHeaders, {
        'Cookie': getCookie(),
    });

    let data = {
        'id': mid,
    };

    return SuperAgent
        .get('http://wos.chijidun.com/order/getMember.html')
        .query(data)
        .withCredentials()
        .set(headers)
        .charset('utf-8')
        .retry(2)
        .end(function(err, res) {
            if (err || !res.ok) {
                console.error(err);
            } else {
                done && done(res);
            }
        });
}
